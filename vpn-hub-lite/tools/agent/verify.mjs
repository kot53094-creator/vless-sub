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
import { writeFileSync } from "node:fs";
import { setTimeout as sleep } from "node:timers/promises";

const BASE = process.env.BASE_URL;
const TOKEN = process.env.CHECK_TOKEN;
const XRAY = process.argv[2] ?? "xray";
const TEST_URL = "https://www.gstatic.com/generate_204";

if (!BASE || !TOKEN) {
  console.error("нужны BASE_URL и CHECK_TOKEN");
  process.exit(1);
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
  if ((q.get("security") ?? "").toLowerCase() !== "reality") return null;

  const uuid = decodeURIComponent(url.username || "");
  const pbk = q.get("pbk") ?? q.get("publicKey") ?? "";
  const sni = q.get("sni") ?? q.get("serverName") ?? "";
  const sid = q.get("sid") ?? q.get("shortId") ?? "";
  const fp = q.get("fp") ?? q.get("fingerprint") ?? "chrome";
  if (!uuid || !pbk || !sni) return null;

  return {
    host: url.hostname,
    port: Number(url.port || 443),
    uuid,
    pbk,
    sni,
    sid,
    fp,
    flow: q.get("flow") ?? "",
  };
}

function buildConfig(p) {
  const user = { id: p.uuid, encryption: "none" };
  if (p.flow) user.flow = p.flow;

  return {
    log: { loglevel: "none" },
    inbounds: [
      { listen: "127.0.0.1", port: 1080, protocol: "socks", settings: { udp: false } },
    ],
    outbounds: [
      {
        protocol: "vless",
        settings: { vnext: [{ address: p.host, port: p.port, users: [user] }] },
        streamSettings: {
          network: "tcp",
          security: "reality",
          realitySettings: {
            serverName: p.sni,
            fingerprint: p.fp,
            publicKey: p.pbk,
            shortId: p.sid,
            spiderX: "/",
          },
        },
      },
    ],
  };
}

function testThroughTunnel() {
  const started = Date.now();
  const code = execFileSync(
    "curl",
    [
      "-s",
      "-o",
      "/dev/null",
      "-w",
      "%{http_code}",
      "--socks5-hostname",
      "127.0.0.1:1080",
      "--max-time",
      "8",
      TEST_URL,
    ],
    { encoding: "utf8", timeout: 12000 },
  ).trim();
  const ok = code === "204" || code === "200";
  return { ok, latency: Date.now() - started, error: ok ? null : `http ${code || "none"}` };
}

const queueResponse = await fetch(`${BASE}/api/checks/queue?limit=40`, {
  headers: { "x-check-token": TOKEN },
});
if (!queueResponse.ok) {
  console.error("очередь не получена:", queueResponse.status);
  process.exit(1);
}
const { queue } = await queueResponse.json();
console.log(`в очереди: ${queue.length}`);

const results = [];

for (const item of queue) {
  const parsed = parseVless(item.link);
  if (!parsed) {
    results.push({ id: item.id, ok: false, error: "не REALITY" });
    continue;
  }

  const path = `/tmp/xray-${item.id}.json`;
  writeFileSync(path, JSON.stringify(buildConfig(parsed)));

  const child = spawn(XRAY, ["run", "-c", path], { stdio: "ignore" });
  await sleep(1200);

  let outcome;
  try {
    outcome = testThroughTunnel();
  } catch (error) {
    outcome = { ok: false, latency: null, error: String(error.message ?? error).slice(0, 120) };
  }

  child.kill("SIGKILL");
  await sleep(150);

  results.push({ id: item.id, ok: outcome.ok, latency: outcome.latency, error: outcome.error });
  console.log(`#${item.id} ${parsed.host}:${parsed.port} -> ${outcome.ok ? "ok" : "fail"} ${outcome.latency ?? ""}`);
}

const posted = await fetch(`${BASE}/api/checks`, {
  method: "POST",
  headers: { "content-type": "application/json", "x-check-token": TOKEN },
  body: JSON.stringify({ results }),
});
console.log("отправлено:", posted.status, await posted.text());
