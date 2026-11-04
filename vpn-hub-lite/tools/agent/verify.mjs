/**
 * Агент проверки REALITY-конфигураций.
 *
 * Запускается на GitHub Actions: скачивает очередь из Worker, поднимает Xray
 * для каждой конфигурации, делает HTTPS-запрос через SOCKS и отправляет
 * результат обратно. Это единственный способ проверить туннель по-настоящему
 * бесплатно — Cloudflare Worker так не умеет.
 *
 * Запуск: node verify.mjs /path/to/xray
 */

import { execFileSync, spawn } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { socksRequest, socksTcp } from "./socks.mjs";
import { connect as netConnect } from "node:net";


// trim + strip BOM: секрет, залитый из Windows/PowerShell или вставленный
// в настройки GitHub, часто приходит с невидимым U+FEFF в начале. Node
// падает на таком значении в заголовке («character at index 0 has a value
// of 65279»), и прогон умирает до первой проверки.
const BASE = (process.env.BASE_URL ?? "").trim().replace(/\/+$/, "");
const TOKEN = (process.env.CHECK_TOKEN ?? "").trim().replace(/^\uFEFF/, "");
// На Windows путь к бинарнику передаём явно: xray.exe лежит рядом с распакованным архивом.
const XRAY = process.argv[2] ?? (process.platform === "win32" ? "xray.exe" : "xray");
const TEST_URL = process.env.TEST_URL ?? "https://www.gstatic.com/generate_204";
// Запасная проверка по обычному HTTP: TLS поверх туннеля у части узлов
// срывается на расшифровке, хотя сам туннель живой (curl через тот же Xray
// отдаёт 204). HTTP идёт по тому же пути и доказывает то же самое.
const HTTP_TEST_URL = process.env.HTTP_TEST_URL ?? "http://cp.cloudflare.com/";
// Сколько узлов проверяем за прогон: локально лучше начинать с 8–10.
const QUEUE_LIMIT = Number(process.env.QUEUE_LIMIT ?? 40) || 40;
const QUEUE_ORDER = (process.env.QUEUE_ORDER ?? "").trim();
const START_DELAY_MS = Number(process.env.XRAY_START_MS ?? 1200) || 1200;
// Базовый SOCKS-порт; на каждую попытку берётся свой, чтобы не ловить занятый.
const SOCKS_BASE = Number(process.env.SOCKS_BASE ?? 21080) || 21080;
const CURL_TIMEOUT = process.env.CURL_TIMEOUT ?? "8";

if (!BASE || !TOKEN) {
  console.error("нужны BASE_URL и CHECK_TOKEN");
  process.exit(1);
}

/**
 * HTTP до воркера через curl, а не через встроенный fetch.
 *
 * На этой машине узел-клиент периодически падает с UND_ERR_CONNECT_TIMEOUT,
 * а Windows PowerShell — с CRYPT_E_REVOCATION_OFFLINE. curl с отключённой
 * проверкой отзыва работает стабильно, поэтому весь обмен с воркером идёт
 * через него. На Linux (GitHub Actions) остаётся обычный fetch.
 */
function httpJson(url, { method = "GET", body = null } = {}) {
  if (process.platform !== "win32") return null;
  const args = [
    "-4",
    "-s",
    "--ssl-no-revoke",
    "--max-time",
    "60",
    "-X",
    method,
    "-H",
    `x-check-token: ${TOKEN}`,
    "-H",
    "User-Agent: vpn-check-agent/2.0",
    "-w",
    "\n%{http_code}",
  ];
  if (body) args.push("-H", "content-type: application/json", "--data-binary", "@-");
  args.push(url);
  try {
    const out = execFileSync("curl.exe", args, {
      input: body ?? undefined,
      encoding: "utf8",
      maxBuffer: 32 * 1024 * 1024,
    });
    const cut = out.lastIndexOf("\n");
    const status = Number(out.slice(cut + 1).trim());
    return { status, text: out.slice(0, cut) };
  } catch (error) {
    return { status: 0, text: String(error.message ?? error) };
  }
}

function parseVless(uri) {
  if (!/^vless:\/\//i.test(uri)) return null;
  let url;
  try {
    url = new URL(uri);
  } catch {
    return null;
  }
  const q = url.searchParams;
  const security = (q.get("security") ?? "").toLowerCase();
  const network = (q.get("type") ?? "tcp").toLowerCase();
  const uuid = decodeURIComponent(url.username || "");
  if (!uuid) return null;

  const sni = q.get("sni") ?? q.get("serverName") ?? "";
  const hostHeader = q.get("host") ?? "";
  const fp = q.get("fp") ?? q.get("fingerprint") ?? "chrome";
  const alpn = q.get("alpn") ?? "";
  const base = {
    host: url.hostname.replace(/^\[|\]$/g, ""),
    port: Number(url.port || 443),
    uuid,
    security,
    network,
    sni,
    fp,
    flow: q.get("flow") ?? "",
  };

  if (security === "reality") {
    const pbk = q.get("pbk") ?? q.get("publicKey") ?? "";
    const sid = q.get("sid") ?? q.get("shortId") ?? "";
    if (!pbk || !sni) return null;
    return { ...base, pbk, sid };
  }

  // TLS проверяем только поверх WebSocket: голый TLS/HTTP2 в РФ режется,
  // а CDN-вариант с ws — рабочий сценарий.
  // TLS поверх ws, gRPC и XHTTP. Голый TLS без транспорта в РФ режется,
  // а эти три — рабочие сценарии через CDN и прямое подключение.
  if (security === "tls" && ["ws", "grpc", "xhttp", "splithttp"].includes(network)) {
    return {
      ...base,
      sni: sni || hostHeader,
      hostHeader,
      path: q.get("path") ?? "/",
      // gRPC без HTTP/2 не поднимается вовсе, а XHTTP в РФ обычно идёт
      // по h2 с откатом на http/1.1. Если клиент не указал ALPN — ставим сами.
      alpn:
        alpn ||
        (network === "grpc"
          ? "h2"
          : network === "xhttp" || network === "splithttp"
            ? "h2,http/1.1"
            : ""),
      serviceName: q.get("serviceName") ?? q.get("service") ?? "",
      mode: q.get("mode") ?? "",
    };
  }

  return null;
}

function buildConfig(p, port) {
  const user = { id: p.uuid, encryption: "none" };
  if (p.flow) user.flow = p.flow;

  // Xray знает транспорт как xhttp; в ссылках он же зовётся splithttp.
  const net = p.network === "splithttp" ? "xhttp" : p.network;
  const stream = { network: net, security: p.security };

  if (net === "grpc") {
    stream.grpcSettings = { serviceName: p.serviceName || "" };
  }
  if (net === "xhttp") {
    stream.xhttpSettings = {
      path: p.path || "/",
      ...(p.hostHeader ? { host: p.hostHeader } : {}),
      ...(p.mode ? { mode: p.mode } : {}),
    };
  }
  if (p.network === "ws") {
    stream.wsSettings = {
      path: p.path || "/",
      headers: p.hostHeader ? { Host: p.hostHeader } : {},
    };
  }
  if (p.security === "reality") {
    stream.realitySettings = {
      serverName: p.sni,
      fingerprint: p.fp,
      publicKey: p.pbk,
      shortId: p.sid,
      spiderX: "/",
    };
  } else if (p.security === "tls") {
    stream.tlsSettings = {
      serverName: p.sni,
      fingerprint: p.fp,
      ...(p.alpn ? { alpn: p.alpn.split(",").map((s) => s.trim()).filter(Boolean) } : {}),
    };
  }

  return {
    log: { loglevel: "none" },
    inbounds: [
      { listen: "127.0.0.1", port, protocol: "socks", settings: { udp: false } },
    ],
    outbounds: [
      {
        protocol: "vless",
        settings: { vnext: [{ address: p.host, port: p.port, users: [user] }] },
        streamSettings: stream,
      },
    ],
  };
}

/**
 * Выходной IP узла: тот адрес, который видит интернет, когда трафик идёт
 * через туннель. Нужен, чтобы отличать «человек сидит через VPN» от
 * «человек качает подписку напрямую». Спрашиваем свой же Worker — он
 * возвращает CF-Connecting-IP, то есть адрес выхода узла.
 */
async function exitIpThroughTunnel(port) {
  const res = await socksRequest(port, `${BASE}/api/ip`);
  if (res.error || !res.body) return null;
  // Тело может прийти с chunked-разметкой — берём всё, что похоже на JSON.
  const start = res.body.indexOf("{");
  const end = res.body.lastIndexOf("}");
  if (start < 0 || end <= start) return null;
  try {
    const parsed = JSON.parse(res.body.slice(start, end + 1));
    return typeof parsed.ip === "string" ? parsed.ip.trim() : null;
  } catch {
    return null;
  }
}

/**
 * Открывает ли узел то, ради чего всё затевалось.
 *
 * Туннель может подняться и отдать 204 от generate_204, но при этом не пускать
 * в Telegram или Discord — тогда сервер в подписке бесполезен. Спрашиваем
 * реальные адреса сервисов через тот же SOCKS-порт.
 */
/**
 * Что узел обязан открывать. Без этого он бесполезен: туннель поднимается,
 * 204 приходит, а Telegram или YouTube не работают — ровно та жалоба, из-за
 * которой всё это переделывалось.
 */
// Проверяем TCP-доступность адресов сервисов, а не HTTPS-страниц.
// Причина: TLS внутри туннеля у части узлов срывается на нашей стороне, и
// рабочий узел получал «Telegram не открывается». TCP-коннект показывает
// именно то, что нужно: пропускает ли провайдер этот адрес.
const REQUIRED_SERVICES = {
  tg: ["149.154.167.51", 443],
  yt: ["142.250.185.46", 443],
};

/** Необязательные: не блокируют узел, но дают бонус в сортировке. */
const OPTIONAL_SERVICES = {
  dc: ["162.159.128.233", 443],
  ig: ["157.240.253.174", 443],
  gpt: ["104.18.32.47", 443],
};

const PING_URL = "https://cp.cloudflare.com/generate_204";
const SPEED_URL = "https://speed.cloudflare.com/__down?bytes=1000000";
const SPEED_MIN_MBPS = Number(process.env.SPEED_MIN_MBPS ?? 3);
const LATENCY_HARD_MAX_MS = Number(process.env.LATENCY_HARD_MAX_MS ?? 800);
// Быстрый режим для массового прогона: два коротких замера без прогрева и без
// измерения скорости. Мёртвый узел стоит ~10 секунд вместо ~35, поэтому
// очередь из сотен серверов проходится за минуты, а не за ночь.
const FAST_PROBE = process.env.FAST_PROBE === "1";

/** Медиана трёх замеров после прогрева: первый запрос платит за TLS. */
async function measureLatency(port) {
  if (!FAST_PROBE) await socksRequest(port, PING_URL, 8000, true);
  const samples = [];
  const attempts = FAST_PROBE ? 2 : 3;
  for (let i = 0; i < attempts; i++) {
    const res = await socksRequest(port, PING_URL, FAST_PROBE ? 5000 : 8000, true);
    if (!res.error && (res.status === 204 || res.status === 200)) samples.push(res.latency);
  }
  if (samples.length < (FAST_PROBE ? 1 : 2)) return null;
  samples.sort((a, b) => a - b);
  return samples[Math.floor(samples.length / 2)];
}

/** Флаги сервисов: обязательные и бонусные в одном проходе. */
async function probeServices(port) {
  const out = {};
  // В массовом прогоне проверяем только обязательные сервисы: бонусные
  // добавляют до 18 секунд на каждый живой узел, а отбор от них не зависит.
  const services = FAST_PROBE
    ? REQUIRED_SERVICES
    : { ...REQUIRED_SERVICES, ...OPTIONAL_SERVICES };
  for (const [name, [host, destPort]] of Object.entries(services)) {
    const res = await socksTcp(port, host, destPort, 6000);
    out[name] = res.ok;
  }
  return out;
}

/** Скорость скачивания ~1 МБ через туннель, Мбит/с. */
async function measureSpeed(port) {
  if (FAST_PROBE) return null;
  const started = Date.now();
  const res = await socksRequest(port, SPEED_URL, 15000, false);
  const secs = (Date.now() - started) / 1000;
  if (res.error || !res.body || secs <= 0) return null;
  const mbps = (Buffer.byteLength(res.body) * 8) / secs / 1e6;
  return Math.round(mbps * 10) / 10;
}

async function testThroughTunnel(port) {
  const latency = await measureLatency(port);
  if (latency === null) return { ok: false, latency: null, error: "туннель не отвечает" };
  if (latency > LATENCY_HARD_MAX_MS) {
    // Медленный — не значит мёртвый. Раньше такой узел получал fail, и при
    // первом же провале вылетал из подписки, хотя через него всё работает.
    // Запоминаем задержку, а решает уже пул: вперёд идут быстрые, медленные
    // остаются резервом, когда быстрых не осталось.
    return { ok: true, latency, error: `медленно: ${latency} мс`, slow: true };
  }

  // Сервисы и скорость не делают узел мёртвым. Живость определяет туннель и
  // задержка; отсутствие YouTube означает лишь, что узел не пройдёт по
  // приоритету. Иначе узел с рабочим Telegram помечался провалившимся и
  // выпадал из подписки, хотя белые списки он обходит.
  const services = await probeServices(port);
  const speed = await measureSpeed(port);

  return { ok: true, latency, error: null, services, speed };
}


/**
 * Ждёт, пока SOCKS-порт начнёт принимать соединения. Фиксированная пауза
 * плоха в обе стороны: на медленной машине Xray ещё не слушает, на быстрой —
 * тратим время зря. Если процесс успел выйти, сразу сообщаем об этом.
 */
function waitForPort(port, child, timeoutMs) {
  return new Promise((resolve) => {
    const deadline = Date.now() + timeoutMs;
    const attempt = () => {
      if (child.exitCode !== null) return resolve(false);
      const probe = netConnect({ host: "127.0.0.1", port });
      let settled = false;
      probe.once("connect", () => {
        settled = true;
        probe.destroy();
        resolve(true);
      });
      probe.once("error", () => {
        if (settled) return;
        probe.destroy();
        if (Date.now() > deadline) resolve(false);
        else setTimeout(attempt, 150);
      });
    };
    attempt();
  });
}

/** На Windows SIGKILL не работает: процесс снимается через taskkill вместе с деревом. */
function killChild(child) {
  if (child.exitCode !== null || child.killed) return;
  try {
    if (process.platform === "win32") {
      // Асинхронно: синхронный запуск на Windows может упасть с EPERM и
      // утащить за собой весь прогон, оставив Xray висеть на порту.
      const killer = spawn("taskkill", ["/PID", String(child.pid), "/T", "/F"], {
        stdio: "ignore",
        windowsHide: true,
      });
      killer.on("error", () => {});
    }
    child.kill();
  } catch {
    /* процесс уже мог завершиться сам */
  }
}

/** Страховка: что бы ни случилось, Xray не должен пережить агента. */
const running = new Set();
for (const signal of ["SIGINT", "SIGTERM", "exit"]) {
  process.on(signal, () => {
    for (const child of running) killChild(child);
  });
}

// CHECK_ID=269 — проверить один конкретный узел, не трогая очередь.
const CHECK_ID = Number(process.env.CHECK_ID ?? 0) || 0;
const queueUrl = CHECK_ID
  ? `${BASE}/api/checks/queue?id=${CHECK_ID}`
  : `${BASE}/api/checks/queue?limit=${QUEUE_LIMIT}&served=1${QUEUE_ORDER ? `&order=${QUEUE_ORDER}` : ""}`;

// NODES_FILE — очередь из локального файла [{id, link}]. Нужна, когда прямой
// HTTPS к Worker из Node не проходит (DPI режет TLS-отпечаток Node): очередь
// тогда забирает curl, а сюда она приходит файлом.
const NODES_FILE = process.env.NODES_FILE ?? "";
let queue = [];
if (NODES_FILE) {
  queue = JSON.parse(readFileSync(NODES_FILE, "utf8"));
  console.log(`в очереди (файл): ${queue.length}`);
} else {
  const viaCurl = httpJson(queueUrl);
  if (viaCurl) {
    if (viaCurl.status !== 200) {
      console.error("очередь не получена:", viaCurl.status, viaCurl.text.slice(0, 160));
      process.exit(1);
    }
    queue = JSON.parse(viaCurl.text).queue;
  } else {
    const queueResponse = await fetch(queueUrl, {
      headers: { "x-check-token": TOKEN },
    });
    if (!queueResponse.ok) {
      console.error("очередь не получена:", queueResponse.status);
      process.exit(1);
    }
    queue = (await queueResponse.json()).queue;
  }
  console.log(`в очереди: ${queue.length}`);
}

const results = [];

for (const item of queue) {
  const parsed = parseVless(item.link);
  if (!parsed) {
    // Проверять нечего: агент умеет только REALITY и WS/gRPC/XHTTP+TLS.
    // Раньше такой узел отправлялся как «провал», и хороший сервер
    // (например, обычный TLS на своём порту) вылетал из подписки из-за
    // ограничения проверялки, а не из-за того, что не работает.
    console.log(`#${item.id} пропущен: протокол не поддерживается проверкой`);
    continue;
  }

  // Свой порт на каждую попытку: иначе зависший Xray от прошлого узла
  // держит SOCKS и весь следующий прогон уходит в fail.
  //
  // Раньше порт считался как SOCKS_BASE + results.length, и при проверке
  // одного узла (CHECK_ID) он всегда был 21080. Если прошлый Xray ещё не
  // успел умереть, новый не мог занять порт и молча выходил — а тест
  // соединялся со старым прокси и писал «узел мёртв». Берём случайный порт
  // из широкого диапазона: шанс пересечения исчезающе мал.
  const socksPort = SOCKS_BASE + 1 + Math.floor(Math.random() * 900);
  const path = join(tmpdir(), `xray-${item.id}.json`);
  writeFileSync(path, JSON.stringify(buildConfig(parsed, socksPort)));

  // XRAY_DEBUG=1 — показать, что Xray пишет в stderr. Без этого любая ошибка
  // конфигурации выглядит как «узел не отвечает»: процесс молча выходит, порт
  // SOCKS закрыт, и проверка валится таймаутом.
  const debug = Boolean(process.env.XRAY_DEBUG);
  const child = spawn(XRAY, ["run", "-c", path], {
    stdio: ["ignore", debug ? "pipe" : "ignore", debug ? "pipe" : "ignore"],
  });
  running.add(child);
  let startError = "";
  let xrayErr = "";
  if (debug) {
    // Xray пишет журнал в stdout, а не в stderr — без этого ошибка конфигурации
    // выглядит просто как «узел не ответил».
    child.stdout?.on("data", (chunk) => {
      xrayErr += chunk;
    });
    child.stderr?.on("data", (chunk) => {
      xrayErr += chunk;
    });
    child.on("exit", (code) => {
      const text = xrayErr.trim();
      if (text) console.log(`   xray[${item.id}] код ${code}: ${text.split(/\r?\n/).slice(0, 4).join(" | ")}`);
    });
  }
  child.on("error", (error) => {
    startError = error.message;
    console.error("xray не запустился:", error.message);
  });

  // Фиксированная пауза плоха в обе стороны: на медленной машине Xray ещё не
  // слушает порт (тест падает), на быстрой — тратим время зря. Ждём именно
  // готовности порта, а если процесс успел выйти, сразу сообщаем об этом.
  const ready = await waitForPort(socksPort, child, START_DELAY_MS + 4000);
  if (!ready) {
    startError = child.exitCode !== null ? "xray завершился до старта" : "socks не поднялся";
  }

  let outcome;
  try {
    outcome = startError
      ? { ok: false, latency: null, error: `xray: ${startError}`.slice(0, 120) }
      : await testThroughTunnel(socksPort);
    // Узел жив — заодно узнаём его выходной IP на том же туннеле.
    // Выходной IP и флаги сервисов уже собраны в testThroughTunnel; здесь
    // остаётся только адрес выхода — он нужен для «включён ли VPN».
    if (outcome.ok) outcome.exit_ip = await exitIpThroughTunnel(socksPort);
  } catch (error) {
    outcome = { ok: false, latency: null, error: String(error.message ?? error).slice(0, 120) };
  }

  killChild(child);
  running.delete(child);
  await sleep(200);

  // gRPC, XHTTP и всё, что живёт за CDN, наш пробник пробивает не всегда:
  // узел может быть рабочим, а тест — нет. Такой провал помечаем мягким,
  // чтобы Worker не записал узел в мёртвые и не выкинул из подписки.
  const soft =
    !outcome.ok && ["grpc", "xhttp", "splithttp", "h2", "http"].includes(parsed.network);

  results.push({
    id: item.id,
    ok: outcome.ok,
    latency: outcome.latency,
    error: outcome.error,
    exit_ip: outcome.exit_ip ?? null,
    // Флаги сервисов: обязательные tg/yt и бонусные dc/ig/gpt.
    services: outcome.services ?? null,
    speed: outcome.speed ?? null,
    soft,
  });
  console.log(
    `#${item.id} ${parsed.host}:${parsed.port} -> ${outcome.ok ? "ok" : soft ? "fail(soft)" : "fail"} ${outcome.latency ?? ""}` +
      (outcome.exit_ip ? ` exit=${outcome.exit_ip}` : ""),
  );
  // Причина провала в консоли: без неё в логе видно только «fail», и такие
  // вещи, как EPERM при запуске curl, приходится выкапывать из базы.
  if (!outcome.ok && outcome.error) console.log(`   причина: ${outcome.error}`);
}

// Worker принимает максимум 20 результатов за вызов: на бесплатном плане
// 50 запросов к D1 на invocation, а каждый результат — это два запроса.
// RESULTS_FILE — сложить результаты в файл вместо отправки. Отправит их curl:
// из Node HTTPS до Worker не проходит, а curl проходит.
const RESULTS_FILE = process.env.RESULTS_FILE ?? "";
if (RESULTS_FILE) {
  writeFileSync(RESULTS_FILE, JSON.stringify({ results }), "utf8");
  console.log(`результаты сохранены: ${RESULTS_FILE} (${results.length})`);
}

// Скобки вокруг тернарника обязательны: без них `i < RESULTS_FILE ? 0 :
// results.length` читается как `(i < RESULTS_FILE) ? 0 : results.length`, и при
// пустом RESULTS_FILE условие всегда истинно — цикл бесконечно отправлял
// пустые пачки, воркер отвечал updated:0, а настоящие результаты так и не
// доходили. Именно из-за этого пул оставался без свежих проверок.
const sendCount = RESULTS_FILE ? 0 : results.length;
for (let i = 0; i < sendCount; i += 20) {
  const chunk = results.slice(i, i + 20);
  const body = JSON.stringify({ results: chunk, region: (process.env.REGION || "").trim() });
  const viaCurl = httpJson(`${BASE}/api/checks`, { method: "POST", body });
  if (viaCurl) {
    console.log(`отправлено ${i + chunk.length}/${results.length}:`, viaCurl.status, viaCurl.text);
  } else {
    const posted = await fetch(`${BASE}/api/checks`, {
      method: "POST",
      headers: { "content-type": "application/json", "x-check-token": TOKEN },
      body,
    });
    console.log(
      `отправлено ${i + chunk.length}/${results.length}:`,
      posted.status,
      await posted.text(),
    );
  }
}

// Дочерний Xray держит цикл событий живым, поэтому гасим всех явно.
//
// Раньше здесь стоял process.exit(0), и это ломало прогон: Node убивал себя
// раньше, чем libuv успевал закрыть каналы дочерних процессов, и на Windows
// вылетало «Assertion failed: !(handle->flags & UV_HANDLE_CLOSING)» с кодом
// -1073740791. Результаты к этому моменту уже отправлены, но планировщик
// видел упавшую задачу. Теперь просто отпускаем цикл событий; страховочный
// таймер снизу на случай, если какой-то сокет всё же зависнет.
for (const child of running) killChild(child);
running.clear();

const guard = setTimeout(() => process.exit(0), 5000);
guard.unref();

