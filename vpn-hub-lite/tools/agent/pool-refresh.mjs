/**
 * Сборка пула: тянет публичные списки, проверяет узлы настоящим туннелем
 * и заливает в Worker только то, что реально передаёт данные.
 *
 * Запуск: run-local.cmd на компьютере владельца — проверка идёт из его сети,
 * то есть в тех же условиях, что у телефона.
 *
 * В D1 не пишет: у бесплатного тарифа суточная квота чтений, из-за неё
 * подписка раньше и отдавала мёртвый список.
 */
import { spawn } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { lookup } from "node:dns";
import { connect } from "node:net";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));

/** Настройки из vpn-hub-lite/pool.env, если их нет в окружении. */
function loadPoolEnv() {
  const path = join(HERE, "..", "..", "pool.env");
  if (!existsSync(path)) return;
  for (const line of readFileSync(path, "utf8").split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const eq = trimmed.indexOf("=");
    if (eq < 1) continue;
    const key = trimmed.slice(0, eq).trim();
    const value = trimmed.slice(eq + 1).trim();
    if (!process.env[key]) process.env[key] = value;
  }
}

loadPoolEnv();

const BASE = (process.env.BASE_URL ?? "").replace(/\/$/, "");
const TOKEN = process.env.CHECK_TOKEN ?? "";
// Xray держим в постоянной папке: в %TEMP% Windows чистит файлы, и проверка
// молча выдавала «0 из 200» — узлы были целы, просто проверять было нечем.
const XRAY = await ensureXray();

async function ensureXray() {
  const explicit = process.env.XRAY_BIN;
  if (explicit && existsSync(explicit)) return explicit;

  const dir = join(process.env.LOCALAPPDATA ?? tmpdir(), "vless-sub-pool");
  mkdirSync(dir, { recursive: true });
  const exe = join(dir, "xray.exe");
  if (existsSync(exe)) return exe;

  const zip = join(dir, "xray.zip");
  log("Xray не найден — скачиваю");
  const res = await fetch(
    "https://github.com/XTLS/Xray-core/releases/download/v26.3.27/Xray-windows-64.zip",
  );
  if (!res.ok) throw new Error(`не удалось скачать Xray: HTTP ${res.status}`);
  writeFileSync(zip, Buffer.from(await res.arrayBuffer()));

  const { execFileSync } = await import("node:child_process");
  execFileSync("tar", ["-xf", zip, "-C", dir], { stdio: "ignore" });
  if (!existsSync(exe)) throw new Error("Xray не распаковался");
  return exe;
}
const LIMIT = Number(process.env.POOL_LIMIT ?? 120);
const SHARDS = Number(process.env.POOL_SHARDS ?? 3);
const MAX_LATENCY = Number(process.env.POOL_MAX_LATENCY ?? 1500);

if (!BASE || !TOKEN) {
  console.error("нужны BASE_URL и CHECK_TOKEN");
  process.exit(1);
}

/** Страны, которые у оператора не работают: проверено живыми тестами. */
// POOL_ALLOW_ALL=1 — не отбрасывать страны из блок-листа. Нужно, когда
// владелец сам прислал подписку и просит взять её узлы как есть.
const BLOCK = process.env.POOL_ALLOW_ALL
  ? new Set()
  : new Set(["JP", "US", "NL", "BG", "NO", "CH"]);

const SOURCES = [
  "https://raw.githubusercontent.com/igareck/vpn-configs-for-russia/main/Vless-Reality-White-Lists-Rus-Mobile.txt",
  "https://raw.githubusercontent.com/igareck/vpn-configs-for-russia/main/BLACK_VLESS_RUS_mobile.txt",
  "https://raw.githubusercontent.com/igareck/vpn-configs-for-russia/main/BLACK_VLESS_RUS.txt",
  "https://raw.githubusercontent.com/barry-far/V2ray-Config/main/Splitted-By-Protocol/vless.txt",
  "https://raw.githubusercontent.com/SoliSpirit/v2ray-configs/main/all_configs.txt",
  "https://raw.githubusercontent.com/ermaozi/get_subscribe/main/subscribe/v2ray.txt",
];

const FLAG_RE = /[\u{1F1E6}-\u{1F1FF}]{2}/u;

function log(message) {
  console.log(`${new Date().toISOString().slice(11, 19)}  ${message}`);
}

function flagToCode(text) {
  const match = FLAG_RE.exec(text ?? "");
  if (!match) return "";
  return [...match[0]]
    .map((ch) => String.fromCharCode(ch.codePointAt(0) - 0x1f1e6 + 65))
    .join("");
}

function isDomain(host) {
  return !/^\d{1,3}(\.\d{1,3}){3}$/.test(host) && host.includes(".");
}

function parseVless(line) {
  if (!line.startsWith("vless://")) return null;
  let url;
  try {
    url = new URL(line);
  } catch {
    return null;
  }
  const port = Number(url.port);
  if (!url.hostname || !port) return null;
  const security = (url.searchParams.get("security") ?? "").toLowerCase();
  let remark = url.hash.replace(/^#/, "");
  try {
    remark = decodeURIComponent(remark);
  } catch {
    // битая метка не должна ронять прогон
  }
  const sni = url.searchParams.get("sni") ?? url.searchParams.get("peer") ?? "";
  const pbk = url.searchParams.get("pbk") ?? "";
  const sid = url.searchParams.get("sid") ?? "";
  const fp = url.searchParams.get("fp") ?? "";
  const flow = url.searchParams.get("flow") ?? "";
  const type = (url.searchParams.get("type") ?? "tcp").toLowerCase();

  // Набор, который выживает при блокировках уровня GFW: REALITY с настоящим
  // публичным ключом и коротким id, домен в SNI и отпечаток браузера.
  // Остальное активный пробинг вскрывает за секунды.
  const strictReality =
    security === "reality" &&
    port === 443 &&
    pbk.length >= 40 &&
    sid.length > 0 &&
    sni.includes(".") &&
    (type === "tcp" ? flow === "xtls-rprx-vision" : true);

  return {
    link: line,
    host: url.hostname,
    port,
    security,
    sni,
    pbk,
    sid,
    fp,
    flow,
    type,
    strict: strictReality,
    remark,
    country: flagToCode(remark),
    white: [443, 8443].includes(port) && ["reality", "tls"].includes(security) && isDomain(url.hostname),
  };
}

async function fetchText(url) {
  // В мобильной сети с белыми списками GitHub то открывается, то нет:
  // три попытки с паузой снимают большинство случайных обрывов.
  let lastError;
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      const res = await fetch(url, {
        headers: { "user-agent": "Mozilla/5.0" },
        signal: AbortSignal.timeout(20000),
      });
      if (!res.ok) throw new Error(`${res.status}`);
      return await res.text();
    } catch (error) {
      lastError = error;
      if (attempt < 2) await new Promise((resolve) => setTimeout(resolve, 2000));
    }
  }
  throw lastError;
}

async function collect() {
  const seen = new Map();

  // Заготовленный список. Нужен, когда проверка идёт в сети, где GitHub
  // закрыт белыми списками: ссылки готовятся заранее, здесь только проверяются.
  if (process.env.POOL_FROM_FILE) {
    const raw = JSON.parse(readFileSync(process.env.POOL_FROM_FILE, "utf8"));
    for (const item of raw) {
      const link = typeof item === "string" ? item : item.link;
      const node = parseVless(String(link ?? "").trim());
      if (!node) continue;
      if (BLOCK.has(node.country)) continue;
      const key = `${node.host}:${node.port}`;
      if (seen.has(key)) continue;
      node.source = "файл";
      seen.set(key, node);
    }
    log(`из файла: ${seen.size}`);
    return [...seen.values()];
  }

  // Можно указать одну конкретную подписку: тогда проверяем только её узлы.
  const sources = process.env.POOL_FROM_URL ? [process.env.POOL_FROM_URL] : SOURCES;
  for (const url of sources) {
    let text;
    try {
      text = await fetchText(url);
      if (!text.includes("://")) {
        const decoded = Buffer.from(text.trim(), "base64").toString("utf8");
        if (decoded.includes("://")) text = decoded;
      }
    } catch (error) {
      log(`источник недоступен: ${url.split("/")[3]} (${error.message})`);
      continue;
    }
    let added = 0;
    for (const raw of text.split(/\r?\n/)) {
      const node = parseVless(raw.trim());
      if (!node) continue;
      if (BLOCK.has(node.country)) continue;
      const key = `${node.host}:${node.port}`;
      if (seen.has(key)) continue;
      node.source = url;
      seen.set(key, node);
      added++;
    }
    log(`источник ${url.split("/")[3]}: +${added}`);
  }
  return [...seen.values()];
}

/** Дешёвая проверка «порт отвечает» перед дорогим туннелем. */
function tcpReachable(host, port, timeoutMs = 2000) {
  return new Promise((resolve) => {
    const socket = connect({ host, port });
    let settled = false;
    const done = (ok) => {
      if (settled) return;
      settled = true;
      socket.destroy();
      resolve(ok);
    };
    socket.setTimeout(timeoutMs);
    socket.once("connect", () => done(true));
    socket.once("timeout", () => done(false));
    socket.once("error", () => done(false));
  });
}

async function filterReachable(nodes, concurrency = 80) {
  const result = new Array(nodes.length).fill(false);
  let cursor = 0;
  await Promise.all(
    Array.from({ length: concurrency }, async () => {
      while (cursor < nodes.length) {
        const index = cursor++;
        result[index] = await tcpReachable(nodes[index].host, nodes[index].port);
      }
    }),
  );
  return nodes.filter((_, index) => result[index]);
}

/**
 * Туннельная проверка в несколько потоков: один узел — 5-10 секунд,
 * последовательно сотня узлов не влезает в разумное время.
 */
function runShard(nodes, shardIndex) {
  return new Promise((resolve, reject) => {
    const dir = mkdtempSync(join(tmpdir(), `pool-${shardIndex}-`));
    const nodesFile = join(dir, "nodes.json");
    const resFile = join(dir, "res.json");
    writeFileSync(nodesFile, JSON.stringify(nodes));

    const child = spawn(process.execPath, [join(HERE, "verify.mjs"), XRAY], {
      env: {
        ...process.env,
        FAST_PROBE: "1",
        SOCKS_BASE: String(24100 + shardIndex * 100),
        NODES_FILE: nodesFile,
        RESULTS_FILE: resFile,
        SPEED_MIN_MBPS: "0",
        LATENCY_HARD_MAX_MS: String(MAX_LATENCY),
      },
      stdio: "ignore",
    });
    child.on("exit", (code) => {
      if (code !== 0) return reject(new Error(`verify exit ${code}`));
      try {
        resolve(JSON.parse(readFileSync(resFile, "utf8")).results ?? []);
      } catch (error) {
        reject(error);
      }
    });
  });
}

async function verifyAll(nodes, shards = SHARDS) {
  // Идентификатор присваивается ДО разбивки на потоки: иначе результат
  // проверки не сопоставить с узлом, и «прошли 3» превращается в «в пул 0».
  const items = nodes.map((node, index) => ({ id: index + 1, link: node.link }));
  const size = Math.ceil(items.length / shards) || 1;
  const chunks = [];
  for (let i = 0; i < items.length; i += size) chunks.push(items.slice(i, i + size));
  log(`проверяю ${items.length} узлов в ${chunks.length} потока(ах)`);
  const results = await Promise.all(chunks.map((chunk, index) => runShard(chunk, index)));
  return results.flat();
}

async function geocode(hosts) {
  const out = new Map();
  const unique = [...new Set(hosts)];
  for (let i = 0; i < unique.length; i += 40) {
    const chunk = unique.slice(i, i + 40);
    try {
      const res = await fetch("http://ip-api.com/batch?fields=status,country,countryCode,city", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(chunk),
      });
      const data = await res.json();
      data.forEach((info, idx) => {
        if (info.status === "success") {
          out.set(chunk[idx], { cc: info.countryCode, country: info.country, city: info.city });
        }
      });
    } catch {
      // ниже попробуем по одному
    }
  }
  for (const host of unique.filter((item) => !out.has(item))) {
    try {
      const res = await fetch(
        `https://ipwho.is/${encodeURIComponent(host)}?fields=success,country,country_code,city`,
      );
      const info = await res.json();
      if (info.success) {
        out.set(host, { cc: info.country_code, country: info.country, city: info.city });
      }
    } catch {
      // ниже спросим воркер
    }
  }

  // Справочники с домашней сети часто недоступны из-за DPI. Воркер ходит
  // к ним из облака и отдаёт готовые страны — метки в клиенте перестают
  // быть голыми доменами.
  const missing = unique.filter((host) => !out.has(host));
  if (missing.length) {
    try {
      const res = await fetch(`${BASE}/api/geo/lookup`, {
        method: "POST",
        headers: { "content-type": "application/json", "x-check-token": TOKEN },
        body: JSON.stringify({ hosts: missing }),
      });
      const data = await res.json();
      for (const [host, info] of Object.entries(data.geo ?? {})) {
        if (info && typeof info === "object" && info.cc) {
          out.set(host, { cc: info.cc, country: info.country ?? null, city: info.city ?? null });
        }
      }
    } catch {
      // останемся без страны — узел всё равно попадёт в пул
    }
  }
  return out;
}

function toRow(node, result, geo, index) {
  const now = new Date().toISOString().slice(0, 19).replace("T", " ");
  return {
    id: 920000 + index,
    source_id: 902,
    remark: node.remark || node.host,
    link: node.link,
    host: node.host,
    port: node.port,
    status: "alive",
    latency_ms: result.latency ?? null,
    last_check_at: now,
    max_users: 0,
    seen_at: now,
    verified_at: now,
    verified_latency_ms: result.latency ?? null,
    blocked_ok: 1,
    exit_ip: null,
    speed_mbps: null,
    country_name: geo?.country ?? null,
    city: geo?.city ?? null,
    country_code: geo?.cc ?? null,
    tier: "free",
    enabled: 1,
    priority: null,
    visibility: "shareable",
    share_until: null,
    source_kind: "public",
    stability: 1,
  };
}

async function post(key, value, ttl = 86400) {
  const res = await fetch(`${BASE}/api/pool/set`, {
    method: "POST",
    headers: { "content-type": "application/json", "x-check-token": TOKEN },
    body: JSON.stringify({ key, value, ttl }),
  });
  log(`${key} → ${res.status} ${(await res.text()).slice(0, 60)}`);
}

/**
 * Показываем, из какой сети идёт проверка.
 *
 * Это принципиально: с домашнего Wi-Fi узлы проходят, а у оператора тот же
 * узел режется DPI. Без этой строки легко решить, что проверка «врёт».
 */
const PROFILE_FILE = join(HERE, "..", "..", "net-profile.json");

/**
 * Отпечаток сети, в которой надо проверять узлы.
 *
 * У оператора с белыми списками проходит совсем не то, что с домашнего Wi-Fi.
 * Поэтому мобильную сеть запоминаем: провайдер, ASN и тип подключения. Дальше
 * каждый прогон сверяется с этим отпечатком, чтобы в подписку не попадали
 * узлы, «рабочие» только для домашней линии.
 */
function readProfile() {
  try {
    return JSON.parse(readFileSync(PROFILE_FILE, "utf8"));
  } catch {
    return null;
  }
}

function sameNetwork(current, saved) {
  if (!current || !saved) return false;
  if (current.asn && saved.asn && current.asn !== saved.asn) return false;
  const ispA = String(current.isp ?? "").toLowerCase();
  const ispB = String(saved.isp ?? "").toLowerCase();
  if (!ispA || !ispB) return false;
  return ispA.includes(ispB.slice(0, 6)) || ispB.includes(ispA.slice(0, 6));
}

async function logNetwork() {
  const mode = (process.env.POOL_NET ?? "any").toLowerCase();
  let current = null;
  try {
    const res = await fetch("https://ipwho.is/?fields=success,country_code,connection,ip");
    const info = await res.json();
    if (info.success) {
      const conn = info.connection ?? {};
      current = {
        ip: info.ip,
        country: info.country_code,
        isp: conn.isp ?? "",
        asn: conn.asn ?? "",
        type: conn.type ?? "",
      };
      log(
        `сеть проверки: ${current.ip} · ${current.country} · ${current.isp} · ${current.type || "?"}`,
      );
    }
  } catch {
    // без сведений о сети продолжаем
  }

  const saved = readProfile();

  if (mode === "save") {
    if (!current) throw new Error("не удалось определить сеть — профиль не сохранён");
    // Защита от «сохранил домашний Wi-Fi как мобильный»: тогда весь смысл
    // проверки теряется, а в подписку попадут узлы, резаные оператором.
    if (!process.env.POOL_FORCE_SAVE && current.type && current.type !== "mobile") {
      throw new Error(
        `это не мобильная сеть: ${current.isp} (тип ${current.type}). ` +
          "Включи точку доступа на телефоне и подключи ноутбук к ней. " +
          "Сохранить всё равно: POOL_FORCE_SAVE=1",
      );
    }
    writeFileSync(PROFILE_FILE, JSON.stringify({ ...current, savedAt: new Date().toISOString() }, null, 2));
    log(`профиль сети сохранён: ${current.isp} (AS${current.asn})`);
    return current;
  }

  if (mode === "require") {
    if (!saved) throw new Error("профиль мобильной сети не сохранён — сначала запусти remember-mobile.cmd");
    if (!sameNetwork(current, saved)) {
      throw new Error(
        `сеть не совпадает с сохранённой (${saved.isp}). Сейчас: ${current?.isp ?? "неизвестно"}. ` +
          "Подключись к мобильной сети и повтори — иначе в подписку попадут узлы, резаные оператором.",
      );
    }
    log(`сеть совпадает с мобильной: ${saved.isp}`);
    return current;
  }

  if (saved) {
    log(
      sameNetwork(current, saved)
        ? "сеть совпадает с сохранённой мобильной"
        : "сеть НЕ совпадает с мобильной: узлы могут не работать у оператора",
    );
  } else if (current?.type === "mobile") {
    log("это мобильный оператор — условия как у телефона");
  }
  return current;
}

await logNetwork();
const nodes = await collect();

// Только собрать список, без проверки. Так готовим заготовку там, где GitHub
// открыт, а проверяем уже в мобильной сети через POOL_FROM_FILE.
if (process.env.POOL_PREFETCH) {
  writeFileSync(process.env.POOL_PREFETCH, JSON.stringify(nodes.map((node) => node.link)));
  log(`список сохранён: ${process.env.POOL_PREFETCH} (${nodes.length} узлов)`);
  process.exit(0);
}

// Кандидаты по кругу из всех источников: иначе проверка уходит в один список.
const bySource = new Map();
for (const node of nodes) {
  if (!bySource.has(node.source)) bySource.set(node.source, []);
  bySource.get(node.source).push(node);
}
for (const list of bySource.values()) {
  list.sort((a, b) => Number(b.white) - Number(a.white));
}

const pooled = [];
const lists = [...bySource.values()];
for (let round = 0; ; round++) {
  let added = 0;
  for (const list of lists) {
    const node = list[round];
    if (node) {
      pooled.push(node);
      added++;
    }
  }
  if (added === 0) break;
}
log(`всего кандидатов: ${pooled.length}`);

// Только «белые списки». На мобильном операторе проходят лишь узлы на 443/8443
// с TLS или REALITY и доменом вместо IP — остальные режет DPI, сколько бы их
// ни было. POOL_WHITE_ONLY=0 отключает фильтр.
const whiteOnly = process.env.POOL_WHITE_ONLY !== "0";

// Блокировки уровня GFW вскрывают всё, кроме REALITY с полным набором
// параметров: ключ, shortId, домен в SNI, отпечаток браузера и vision-flow.
// POOL_STRICT_REALITY=0 возвращает мягкий отбор.
const strictOnly = process.env.POOL_STRICT_REALITY === "1";
const strictCount = pooled.filter((node) => node.strict).length;
if (strictOnly) log(`строгий REALITY (GFW-набор): ${strictCount} из ${pooled.length}`);

// Узлы за Cloudflare (104.16–31.x, 172.64–71.x, 162.158–159.x) на мобильном
// режутся целыми диапазонами: адрес CDN у оператора в блок-листе, сколько бы
// ни был правильным REALITY. Для мобильного прогона такие выкидываем.
async function mapLimit(items, limit, worker) {
  const out = new Array(items.length);
  let cursor = 0;
  const runners = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (cursor < items.length) {
      const index = cursor++;
      try {
        out[index] = await worker(items[index]);
      } catch {
        out[index] = false;
      }
    }
  });
  await Promise.all(runners);
  return out;
}

async function behindCdn(node) {
  if (process.env.POOL_EXCLUDE_CDN !== "1") return false;
  const ip = await resolveIp(node.host);
  if (!ip) return false;
  const [a, b] = ip.split(".").map(Number);
  if (a === 104 && b >= 16 && b <= 31) return true;
  if (a === 172 && b >= 64 && b <= 71) return true;
  if (a === 162 && b >= 158 && b <= 159) return true;
  if (a === 141 && b >= 101 && b <= 101) return true;
  if (a === 188 && b === 114) return true;
  if (a === 190 && b === 93) return true;
  if (a === 198 && b === 41) return true;
  return false;
}

function resolveIp(host) {
  return new Promise((resolve) => {
    lookup(host, { family: 4 }, (error, address) => resolve(error ? "" : address));
  });
}

const filteredBase = strictOnly ? pooled.filter((node) => node.strict) : pooled;

// DNS-проверка идёт параллельно и только по окну кандидатов: последовательный
// перебор трёх тысяч хостов занимал минуты и съедал всё время прогона.
const window = filteredBase.slice(0, Number(process.env.POOL_CDN_WINDOW ?? 900));
const cdnFlags = await mapLimit(window, 60, (node) => behindCdn(node));
const base = window.filter((_, index) => !cdnFlags[index]);
if (process.env.POOL_EXCLUDE_CDN === "1") {
  log(`после отсева Cloudflare: ${base.length} из ${filteredBase.length}`);
}
const scoped = whiteOnly ? base.filter((node) => node.white) : base;
log(`после фильтра белых списков: ${scoped.length}`);

const reachable = await filterReachable(scoped.slice(0, Math.max(LIMIT * 3, 600)));
log(`порт отвечает у ${reachable.length}`);

const candidates = reachable.slice(0, LIMIT);
const results = await verifyAll(candidates);
const ok = results.filter((item) => item.ok);
log(`первый проход: ${ok.length} из ${candidates.length}`);

// Второй проход.
//
// Публичные узлы часто отдают один пакет и умирают: первый тест проходит,
// человек подключается — тишина. Поэтому выживших проверяем ещё раз через
// паузу и оставляем только тех, кто прошёл оба раза.
let alive = [];
if (ok.length > 0) {
  const subset = ok.map((item) => candidates[item.id - 1]).filter(Boolean);
  const pauseMs = Number(process.env.POOL_RECHECK_PAUSE ?? 20000);
  log(`второй проход через ${Math.round(pauseMs / 1000)} с: ${subset.length} узлов`);
  await new Promise((resolve) => setTimeout(resolve, pauseMs));
  const second = await verifyAll(subset);
  const passed = new Map(second.filter((item) => item.ok).map((item) => [item.id, item]));
  alive = subset
    .map((node, index) => ({ node, result: passed.get(index + 1) }))
    .filter((item) => item.result)
    .sort((a, b) => (a.result.latency ?? 1e9) - (b.result.latency ?? 1e9));
  log(`второй проход прошли: ${alive.length} из ${subset.length}`);
}

const geo = await geocode(alive.map((item) => item.node.host));
// Страна — украшение, а не условие. Сервисы геолокации на этой сети часто
// недоступны, и раньше из-за этого выбрасывались уже проверенные туннелем
// узлы: «в пул: 0» при трёх рабочих.
const rows = alive
  .map((item, idx) => {
    const info =
      geo.get(item.node.host) ??
      (item.node.country ? { cc: item.node.country, country: null, city: null } : null);
    return toRow(item.node, item.result, info, idx);
  })
  // Порог скорости больше не отбрасывает узлы: у мобильного оператора
  // задержка сама по себе выше, и три проверенных узла превращались в ноль.
  // Вместо отсечения — сортировка по задержке и ограничение количества.
  .filter((row) => !row.country_code || !BLOCK.has(row.country_code))
  .sort((a, b) => (a.verified_latency_ms ?? 1e9) - (b.verified_latency_ms ?? 1e9))
  .slice(0, 14);

const white = rows.filter((row) => [443, 8443].includes(row.port));
log(`в пул: ${rows.length}, из них 443/8443: ${white.length}`);

if (rows.length < 1) {
  log("ни один узел не прошёл туннель — пул не меняю");
  process.exit(2);
}

await post("pool:verified:v19", rows);
await post("pool:whitelist:v1", white);
await post("pool:rescue:v1", rows);
await post("pool:stamp", String(Math.floor(Date.now() / 1000)));

writeFileSync("pool-last.json", JSON.stringify(rows, null, 1));
for (const row of rows) {
  log(`  ${row.verified_latency_ms} мс  ${row.country_code}  ${row.host}:${row.port}`);
}
log("готово");
