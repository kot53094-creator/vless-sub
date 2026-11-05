/**
 * Обновление пула подписки целиком в облаке.
 *
 * Запускается на GitHub Actions по расписанию: скачивает публичные списки,
 * проверяет узлы настоящим туннелем (verify.mjs + Xray), собирает пул и
 * кладёт его в KV через Worker. Компьютер владельца не участвует — прогон
 * идёт, даже когда он выключен.
 *
 * Два шага:
 *   node refresh_pool.mjs prep    — собрать очередь кандидатов в nodes.json
 *   node refresh_pool.mjs finish  — прочитать результаты проверки и залить пул
 *
 * Настройки через переменные окружения:
 *   BASE_URL   — адрес Worker (обязателен для finish)
 *   CHECK_TOKEN — админ-токен Worker
 *   LIMIT      — сколько узлов проверять за прогон (по умолчанию 180)
 *   MIN_OK     — минимум рабочих узлов, иначе пул не перезаписываем (8)
 */
import { readFileSync, writeFileSync } from "node:fs";
import { lookup } from "node:dns/promises";

const BASE = (process.env.BASE_URL ?? "").replace(/\/+$/, "");
const TOKEN = (process.env.CHECK_TOKEN ?? "").trim().replace(/^\uFEFF/, "");
const LIMIT = Number(process.env.LIMIT ?? 180) || 180;
const MIN_OK = Number(process.env.MIN_OK ?? 8) || 8;
const NODES_FILE = process.env.NODES_FILE ?? "nodes.json";
const RESULTS_FILE = process.env.RESULTS_FILE ?? "results.json";

const BLOCK = new Set(["JP", "US", "NL", "BG", "NO", "CH"]);
const CDN = ["pages.dev", "workers.dev", "vercel.app", "netlify.app"];

const SOURCES = [
  "https://raw.githubusercontent.com/igareck/vpn-configs-for-russia/main/Vless-Reality-White-Lists-Rus-Mobile.txt",
  "https://raw.githubusercontent.com/igareck/vpn-configs-for-russia/main/BLACK_VLESS_RUS_mobile.txt",
  "https://raw.githubusercontent.com/igareck/vpn-configs-for-russia/main/BLACK_VLESS_RUS.txt",
  "https://raw.githubusercontent.com/barry-far/V2ray-Config/main/Splitted-By-Protocol/vless.txt",
  "https://raw.githubusercontent.com/SoliSpirit/v2ray-configs/main/all_configs.txt",
];

const NAMES = {
  RU: "Россия", LV: "Латвия", LT: "Литва", EE: "Эстония", PL: "Польша",
  DE: "Германия", FI: "Финляндия", SE: "Швеция", FR: "Франция", CZ: "Чехия",
  SK: "Словакия", KZ: "Казахстан", AM: "Армения", GE: "Грузия", TR: "Турция",
  RS: "Сербия", MD: "Молдова", GB: "Великобритания", AT: "Австрия", HU: "Венгрия",
  RO: "Румыния", GR: "Греция", IT: "Италия", ES: "Испания", PT: "Португалия",
  BE: "Бельгия", DK: "Дания", IE: "Ирландия", SI: "Словения", HR: "Хорватия",
  UA: "Украина", IS: "Исландия", LU: "Люксембург", MT: "Мальта", CY: "Кипр",
  CA: "Канада", HK: "Гонконг", SG: "Сингапур", KR: "Корея", IN: "Индия",
  AE: "ОАЭ", IL: "Израиль", BY: "Беларусь", AZ: "Азербайджан", UZ: "Узбекистан",
  KG: "Киргизия", TH: "Таиланд", VN: "Вьетнам", MY: "Малайзия", ID: "Индонезия",
  BR: "Бразилия", AR: "Аргентина", MX: "Мексика", ZA: "ЮАР", EG: "Египет",
  AU: "Австралия", NZ: "Новая Зеландия", CN: "Китай", TW: "Тайвань", MN: "Монголия",
};

const NEIGHBORS = new Set([
  "LV", "LT", "EE", "PL", "DE", "FI", "SE", "FR", "CZ", "SK", "KZ", "AM", "GE", "TR", "RS", "MD", "RU",
]);

const FLAG_RE = /[\u{1F1E6}-\u{1F1FF}]{2}/u;

function flagToCode(text) {
  const m = FLAG_RE.exec(text ?? "");
  if (!m) return "";
  return [...m[0]].map((ch) => String.fromCharCode(ch.codePointAt(0) - 0x1f1e6 + 65)).join("");
}

function isDomain(host) {
  return !/^\d{1,3}(\.\d{1,3}){3}$/.test(host) && host.includes(".") && /[a-z]/i.test(host);
}

function parseVless(link) {
  if (!/^vless:\/\//i.test(link)) return null;
  let url;
  try {
    url = new URL(link);
  } catch {
    return null;
  }
  const host = (url.hostname ?? "").replace(/^\[|\]$/g, "");
  const port = Number(url.port) || 443;
  if (!host) return null;
  const security = (url.searchParams.get("security") ?? "").toLowerCase();
  if (security !== "reality" && security !== "tls") return null;
  // Метка приходит из чужого файла: кривая кодировка не должна ронять прогон.
  let remark = "";
  try {
    remark = decodeURIComponent(url.hash.replace(/^#/, "") ?? "");
  } catch {
    remark = url.hash.replace(/^#/, "") ?? "";
  }
  return {
    link,
    host,
    port,
    security,
    remark,
    country: flagToCode(remark),
    white: [443, 8443].includes(port) && isDomain(host),
  };
}

async function fetchText(url) {
  const res = await fetch(url, { headers: { "user-agent": "vpn-hub-refresh" } });
  if (!res.ok) throw new Error(`${url}: ${res.status}`);
  return await res.text();
}

function decodeMaybeBase64(text) {
  if (text.includes("vless://")) return text;
  try {
    return Buffer.from(text, "base64").toString("utf8");
  } catch {
    return text;
  }
}

async function prep() {
  const candidates = new Map();
  for (const url of SOURCES) {
    let text = "";
    try {
      text = decodeMaybeBase64(await fetchText(url));
    } catch (error) {
      console.log(`источник пропущен: ${error.message}`);
      continue;
    }
    let added = 0;
    for (const line of text.split(/\r?\n/)) {
      const node = parseVless(line.trim());
      if (!node) continue;
      if (BLOCK.has(node.country)) continue;
      if (CDN.some((host) => node.link.includes(host))) continue;
      const key = `${node.host}:${node.port}`;
      if (candidates.has(key)) continue;
      candidates.set(key, node);
      added += 1;
    }
    console.log(`источник ${url.split("/").pop()}: +${added}`);
  }

  const all = [...candidates.values()].sort((a, b) => {
    const whiteDiff = Number(b.white) - Number(a.white);
    if (whiteDiff !== 0) return whiteDiff;
    const nearDiff = Number(NEIGHBORS.has(b.country)) - Number(NEIGHBORS.has(a.country));
    if (nearDiff !== 0) return nearDiff;
    return a.host.localeCompare(b.host);
  });

  const perHost = new Map();
  const picked = [];
  for (const node of all) {
    const used = perHost.get(node.host) ?? 0;
    if (used >= 2) continue;
    perHost.set(node.host, used + 1);
    picked.push(node);
    if (picked.length >= LIMIT) break;
  }

  const queue = picked.map((node, index) => ({ id: 500000 + index, link: node.link }));
  writeFileSync(NODES_FILE, JSON.stringify(queue), "utf8");
  writeFileSync("candidates.json", JSON.stringify(picked), "utf8");
  console.log(`кандидатов ${all.length}, к проверке ${queue.length} (белых ${picked.filter((n) => n.white).length})`);
}

async function geoOf(host) {
  try {
    const ip = /^\d{1,3}(\.\d{1,3}){3}$/.test(host) ? host : await lookup(host).then((r) => r.address);
    const res = await fetch(`https://ipwho.is/${ip}?fields=success,country,country_code,city`, {
      headers: { "user-agent": "curl/8.5" },
    });
    const data = await res.json();
    if (!data.success) return null;
    return { code: data.country_code || null, name: data.country || null, city: data.city || null };
  } catch {
    return null;
  }
}

async function post(key, value, ttl = 172800) {
  const res = await fetch(`${BASE}/api/pool/set`, {
    method: "POST",
    headers: { "content-type": "application/json", "x-check-token": TOKEN, "user-agent": "Mozilla/5.0" },
    body: JSON.stringify({ key, value, ttl }),
  });
  const text = await res.text();
  console.log(`${key}: ${res.status} ${text.slice(0, 100)}`);
  if (!res.ok) throw new Error(`запись ${key} не удалась: ${res.status}`);
}

async function finish() {
  if (!BASE || !TOKEN) throw new Error("нужны BASE_URL и CHECK_TOKEN");

  const results = JSON.parse(readFileSync(RESULTS_FILE, "utf8")).results ?? [];
  const candidates = JSON.parse(readFileSync("candidates.json", "utf8"));
  const byId = new Map(candidates.map((node, index) => [500000 + index, node]));

  const ok = [];
  for (const result of results) {
    if (!result.ok) continue;
    const node = byId.get(result.id);
    if (!node) continue;
    const latency = Number(result.latency ?? 0);
    if (!latency || latency > 2500) continue;
    ok.push({ node, latency });
  }
  ok.sort((a, b) => Number(b.node.white) - Number(a.node.white) || a.latency - b.latency);

  console.log(`проверено ${results.length}, рабочих ${ok.length}`);
  if (ok.length < MIN_OK) {
    throw new Error(`рабочих всего ${ok.length} (< ${MIN_OK}) — пул не трогаем, чтобы не отдать людям пустой список`);
  }

  const now = new Date().toISOString().replace("T", " ").slice(0, 19);
  const rows = [];
  const hostCount = new Map();
  for (const { node, latency } of ok) {
    const used = hostCount.get(node.host) ?? 0;
    if (used >= 3) continue;
    const geo = await geoOf(node.host);
    if (geo?.code && BLOCK.has(geo.code)) continue;
    hostCount.set(node.host, used + 1);
    rows.push({
      id: 920000 + rows.length,
      source_id: 902,
      remark: node.remark || node.host,
      link: node.link,
      host: node.host,
      port: node.port,
      status: "alive",
      latency_ms: latency,
      last_check_at: now,
      max_users: 0,
      seen_at: now,
      verified_at: now,
      verified_latency_ms: latency,
      blocked_ok: 1,
      exit_ip: null,
      speed_mbps: null,
      country_name: geo?.name ?? (NAMES[node.country] || null),
      city: geo?.city ?? null,
      country_code: geo?.code ?? (node.country || null),
      tier: "free",
      enabled: 1,
      priority: null,
      visibility: "shareable",
      share_until: null,
      source_kind: "public",
      stability: 1,
    });
    if (rows.length >= 60) break;
  }

  if (rows.length < MIN_OK) throw new Error(`после гео осталось ${rows.length} — пул не трогаем`);

  const white = rows.filter((row) => [443, 8443].includes(Number(row.port)));
  await post("pool:rescue:v1", rows);
  await post("pool:whitelist:v1", white);
  await post("pool:verified:v19", rows);
  await post("direct:links", "");
  await post("pool:stamp", String(Math.floor(Date.now() / 1000)));

  console.log(`в пуле ${rows.length} узлов, белых ${white.length}`);
  for (const row of rows.slice(0, 15)) {
    console.log(`  ${row.verified_latency_ms} ms ${row.country_code} ${row.host}:${row.port}`);
  }
}

const mode = process.argv[2];
if (mode === "prep") await prep();
else if (mode === "finish") await finish();
else {
  console.error("режим: prep | finish");
  process.exit(1);
}
