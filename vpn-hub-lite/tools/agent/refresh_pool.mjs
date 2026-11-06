/**
 * Ночная сборка пула целиком в облаке.
 *
 * Запускается на раннере GitHub (не на компьютере владельца):
 *   1. тянет публичные списки, которые реально обновляются;
 *   2. проверяет VLESS настоящим туннелем через Xray;
 *   3. заливает проверенный пул в Worker через /api/pool/set.
 *
 * Ничего не пишет в D1: у бесплатного тарифа суточная квота чтений, и именно
 * из-за неё подписка раньше отдавала мёртвый список.
 */
import { spawn } from "node:child_process";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
import { join } from "node:path";

const BASE = (process.env.BASE_URL ?? "").replace(/\/$/, "");
const TOKEN = process.env.CHECK_TOKEN ?? "";
const XRAY = process.env.XRAY_BIN ?? "xray";
const LIMIT = Number(process.env.POOL_LIMIT ?? 240);

if (!BASE || !TOKEN) {
  console.error("нужны BASE_URL и CHECK_TOKEN");
  process.exit(1);
}

/**
 * Списки, которые действительно отвечают. Три адреса из старой инструкции
 * отдают 404: репозитории переименованы. Эти проверены вручную.
 */
const SOURCES = [
  "https://raw.githubusercontent.com/igareck/vpn-configs-for-russia/main/Vless-Reality-White-Lists-Rus-Mobile.txt",
  "https://raw.githubusercontent.com/igareck/vpn-configs-for-russia/main/BLACK_VLESS_RUS_mobile.txt",
  "https://raw.githubusercontent.com/igareck/vpn-configs-for-russia/main/BLACK_VLESS_RUS.txt",
  "https://raw.githubusercontent.com/barry-far/V2ray-Config/main/Splitted-By-Protocol/vless.txt",
  "https://raw.githubusercontent.com/SoliSpirit/v2ray-configs/main/all_configs.txt",
  "https://raw.githubusercontent.com/ermaozi/get_subscribe/main/subscribe/v2ray.txt",
];

const BLOCK = new Set(["JP", "US", "NL", "BG", "NO", "CH"]);
const FLAG_RE = /[\u{1F1E6}-\u{1F1FF}]{2}/u;

function flagToCode(text) {
  const match = FLAG_RE.exec(text ?? "");
  if (!match) return "";
  return [...match[0]].map((ch) => String.fromCharCode(ch.codePointAt(0) - 0x1f1e6 + 65)).join("");
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
  const q = url.searchParams;
  // Метки в публичных списках бывают битыми: decodeURIComponent на них
  // бросает URIError и роняет весь прогон. Метка нужна только для флага
  // страны, поэтому при ошибке берём сырой фрагмент.
  let remark = url.hash.replace(/^#/, "");
  try {
    remark = decodeURIComponent(remark);
  } catch {
    // оставляем как есть
  }
  return {
    link: line,
    host: url.hostname,
    port,
    security: (q.get("security") ?? "").toLowerCase(),
    remark,
    country: flagToCode(remark),
    white: [443, 8443].includes(port) && ["reality", "tls"].includes((q.get("security") ?? "").toLowerCase()) && isDomain(url.hostname),
  };
}

async function fetchText(url) {
  const res = await fetch(url, { headers: { "user-agent": "Mozilla/5.0" } });
  if (!res.ok) throw new Error(`${res.status}`);
  return res.text();
}

async function collect() {
  const seen = new Map();
  const hy2 = [];
  for (const url of SOURCES) {
    let text;
    try {
      text = await fetchText(url);
    } catch (error) {
      console.log(`источник недоступен: ${url} (${error.message})`);
      continue;
    }
    let nodes = 0;
    for (const raw of text.split(/\r?\n/)) {
      const line = raw.trim();
      if (line.startsWith("hysteria2://") || line.startsWith("hy2://")) {
        if (hy2.length < 40) hy2.push(line);
        continue;
      }
      const node = parseVless(line);
      if (!node) continue;
      if (BLOCK.has(node.country)) continue;
      const key = `${node.host}:${node.port}`;
      if (seen.has(key)) continue;
      seen.set(key, node);
      nodes++;
    }
    console.log(`источник ok: ${url.split("/")[3]} → ${nodes}`);
  }
  return { nodes: [...seen.values()], hy2 };
}

function runVerify(nodes) {
  return new Promise((resolve, reject) => {
    const dir = mkdtempSync(join(tmpdir(), "pool-"));
    const nodesFile = join(dir, "nodes.json");
    const resFile = join(dir, "res.json");
    writeFileSync(nodesFile, JSON.stringify(nodes.map((n, i) => ({ id: i + 1, link: n.link }))));

    const child = spawn(process.execPath, [join(HERE, "verify.mjs"), XRAY], {
      env: {
        ...process.env,
        FAST_PROBE: "1",
        SOCKS_BASE: "24100",
        NODES_FILE: nodesFile,
        RESULTS_FILE: resFile,
        SPEED_MIN_MBPS: "0",
        LATENCY_HARD_MAX_MS: "1500",
      },
      stdio: "inherit",
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
          out.set(chunk[idx], {
            cc: info.countryCode,
            country: info.country,
            city: info.city,
          });
        }
      });
    } catch {
      // без гео узел останется без страны и не попадёт в пул — это честнее
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

async function post(key, value, ttl = 172800) {
  const res = await fetch(`${BASE}/api/pool/set`, {
    method: "POST",
    headers: { "content-type": "application/json", "x-check-token": TOKEN },
    body: JSON.stringify({ key, value, ttl }),
  });
  console.log(`${key} → ${res.status} ${(await res.text()).slice(0, 80)}`);
}

const { nodes, hy2 } = await collect();
console.log(`кандидатов VLESS: ${nodes.length}, hysteria2 в списках: ${hy2.length}`);

// Белые списки первыми: они нужнее на мобильном интернете.
nodes.sort((a, b) => Number(b.white) - Number(a.white));
const candidates = nodes.slice(0, LIMIT);

const results = await runVerify(candidates);
const okResults = results.filter((r) => r.ok);
console.log(`туннель прошли: ${okResults.length} из ${candidates.length}`);

const alive = okResults
  .map((r) => ({ node: candidates[r.id - 1], result: r }))
  .filter((item) => item.node)
  .sort((a, b) => (a.result.latency ?? 1e9) - (b.result.latency ?? 1e9));

const geo = await geocode(alive.map((item) => item.node.host));
const rows = alive
  .filter((item) => geo.has(item.node.host))
  .map((item, idx) => toRow(item.node, item.result, geo.get(item.node.host), idx))
  .filter((row) => !BLOCK.has(row.country_code ?? ""));

const white = rows.filter((row) => [443, 8443].includes(row.port));

console.log(`в пул: ${rows.length}, из них 443/8443: ${white.length}`);
if (rows.length < 5) {
  console.error("меньше пяти рабочих узлов — пул не трогаем");
  process.exit(2);
}

await post("pool:verified:v19", rows);
await post("pool:whitelist:v1", white);
await post("pool:rescue:v1", rows);
await post("direct:links", hy2.join("\n"));
await post("pool:stamp", String(Math.floor(Date.now() / 1000)));

writeFileSync("pool-last.json", JSON.stringify({ rows, hy2: hy2.length }, null, 1));
console.log("готово");
