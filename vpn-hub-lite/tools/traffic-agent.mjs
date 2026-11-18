#!/usr/bin/env node
/**
 * Агент учёта трафика для своих узлов Xray.
 *
 * Зачем: Cloudflare Worker не видит объём, прошедший через туннель. Считать
 * может только сам узел — Xray ведёт статистику по email пользователя.
 * Агент раз в 5 минут читает счётчики, считает дельты и отправляет их в
 * панель: POST /api/traffic.
 *
 * Требования:
 *   • на узле запущен Xray с API (порт 10085 по умолчанию);
 *   • email в inbound'е равен токену подписки человека (`sub_token`);
 *   • Node.js 18+.
 *
 * Переменные окружения:
 *   PANEL_URL     https://vpn.example      (без слэша на конце)
 *   CHECK_TOKEN   тот же токен, что у агента проверок
 *   NODE_NAME     de-frankfurt-1
 *   XRAY_API     127.0.0.1:10085
 *   XRAY_BIN      xray                      (путь к бинарю, если не в PATH)
 *   STATE_FILE    ./traffic-state.json      (снимок прошлых значений)
 *
 * Запуск по cron:
 *   *\/5 * * * * cd /opt/vpn && /usr/bin/node tools/traffic-agent.mjs
 */

import { execFile } from "node:child_process";
import { readFile, writeFile } from "node:fs/promises";
import { promisify } from "node:util";

const run = promisify(execFile);

const PANEL_URL = (process.env.PANEL_URL || "").replace(/\/$/, "");
const CHECK_TOKEN = process.env.CHECK_TOKEN || "";
const NODE_NAME = process.env.NODE_NAME || "node";
const XRAY_API = process.env.XRAY_API || "127.0.0.1:10085";
const XRAY_BIN = process.env.XRAY_BIN || "xray";
const STATE_FILE = process.env.STATE_FILE || "./traffic-state.json";

function die(message) {
  console.error(`[traffic-agent] ${message}`);
  process.exit(1);
}

if (!PANEL_URL || !CHECK_TOKEN) die("нужны PANEL_URL и CHECK_TOKEN");

/** `xray api statsquery` → { email: bytes } */
async function readCounters() {
  const { stdout } = await run(XRAY_BIN, [
    "api",
    "statsquery",
    `-server=${XRAY_API}`,
    "-pattern",
    "user>>>",
    "-reset=false",
  ]);

  let parsed;
  try {
    parsed = JSON.parse(stdout);
  } catch {
    return {};
  }

  const counters = {};
  for (const stat of parsed.stat ?? []) {
    // user>>>sub_abc>>>traffic>>>uplink
    const match = /^user>>>(.+)>>>traffic>>>(uplink|downlink)$/.exec(stat.name ?? "");
    if (!match) continue;
    const [, email, direction] = match;
    const bytes = Number(stat.value ?? 0);
    if (!Number.isFinite(bytes) || bytes <= 0) continue;
    counters[email] = (counters[email] ?? 0) + bytes;
  }
  return counters;
}

async function readState() {
  try {
    const raw = await readFile(STATE_FILE, "utf8");
    const data = JSON.parse(raw);
    return { seq: Number(data.seq ?? 0), counters: data.counters ?? {} };
  } catch {
    return { seq: 0, counters: {} };
  }
}

async function main() {
  const current = await readCounters();
  const state = await readState();

  const items = [];
  for (const [token, bytes] of Object.entries(current)) {
    const before = Number(state.counters[token] ?? 0);
    // Счётчик мог обнулиться после рестарта Xray — тогда «дельтой» станет
    // весь текущий объём, что честно: трафик действительно был потрачен.
    const delta = bytes >= before ? bytes - before : bytes;
    if (delta <= 0) continue;
    items.push({ token, mb: Math.round((delta / 1024 / 1024) * 10) / 10 });
  }

  if (!items.length) {
    console.log("[traffic-agent] новых данных нет");
    return;
  }

  // Панель принимает до 40 записей за вызов.
  for (let offset = 0; offset < items.length; offset += 40) {
    const chunk = items.slice(offset, offset + 40);
    const seq = state.seq + 1 + offset;
    const response = await fetch(`${PANEL_URL}/api/traffic`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-check-token": CHECK_TOKEN,
      },
      body: JSON.stringify({ node: NODE_NAME, seq, items: chunk }),
    });
    if (!response.ok) {
      die(`панель ответила ${response.status}: ${await response.text()}`);
    }
    const result = await response.json();
    console.log(`[traffic-agent] отправлено ${result.accepted ?? 0}, seq=${seq}`);
  }

  await writeFile(
    STATE_FILE,
    JSON.stringify({ seq: state.seq + 1, counters: current }, null, 2),
    "utf8",
  );
}

main().catch((error) => die(error?.message ?? String(error)));
