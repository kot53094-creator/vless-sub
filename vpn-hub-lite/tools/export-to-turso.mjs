/**
 * Перенос данных из D1 в Turso.
 *
 * Что делает: выгружает каждую таблицу через wrangler, затем заливает строки
 * в Turso пачками по 50 выражений через /v2/pipeline.
 *
 * Запуск (нужны TURSO_URL и TURSO_TOKEN в окружении):
 *   $env:TURSO_URL="libsql://..."; $env:TURSO_TOKEN="..."; node tools/export-to-turso.mjs
 *
 * Схему создаём отдельно: tools/turso-schema.sql (там же, где миграции).
 */

import { execFileSync } from "node:child_process";

const URL_BASE = (process.env.TURSO_URL ?? "").replace(/\/$/, "");
const TOKEN = process.env.TURSO_TOKEN ?? "";
if (!URL_BASE || !TOKEN) {
  console.error("нужны TURSO_URL и TURSO_TOKEN");
  process.exit(1);
}

function d1(sql) {
  const out = execFileSync(
    "npx",
    ["wrangler", "d1", "execute", "vpn-hub-lite", "--remote", "--json", "--command", sql],
    { encoding: "utf8", maxBuffer: 256 * 1024 * 1024 },
  );
  const start = out.indexOf("[");
  const parsed = JSON.parse(out.slice(start));
  return parsed[0]?.results ?? [];
}

function encode(value) {
  if (value === null || value === undefined) return { type: "null" };
  if (typeof value === "number") {
    return Number.isInteger(value)
      ? { type: "integer", value: String(value) }
      : { type: "float", value };
  }
  return { type: "text", value: String(value) };
}

async function push(statements) {
  const res = await fetch(`${URL_BASE}/v2/pipeline`, {
    method: "POST",
    headers: { authorization: `Bearer ${TOKEN}`, "content-type": "application/json" },
    body: JSON.stringify({
      requests: [...statements.map((stmt) => ({ type: "execute", stmt })), { type: "close" }],
    }),
  });
  if (!res.ok) throw new Error(`turso ${res.status}: ${(await res.text()).slice(0, 300)}`);
  const data = await res.json();
  const bad = (data.results ?? []).find((item) => item.error);
  if (bad) throw new Error(`turso: ${bad.error?.message ?? "ошибка"}`);
}

const tables = d1("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'")
  .map((row) => row.name)
  .filter((name) => !name.startsWith("_cf"));

for (const table of tables) {
  const rows = d1(`SELECT * FROM "${table}"`);
  if (!rows.length) {
    console.log(`${table}: пусто`);
    continue;
  }

  const columns = Object.keys(rows[0]);
  const placeholders = columns.map(() => "?").join(", ");
  const statements = rows.map((row) => ({
    sql: `INSERT OR REPLACE INTO "${table}" (${columns.map((c) => `"${c}"`).join(", ")}) VALUES (${placeholders})`,
    args: columns.map((column) => encode(row[column])),
  }));

  for (let i = 0; i < statements.length; i += 50) {
    await push(statements.slice(i, i + 50));
  }
  console.log(`${table}: ${rows.length} строк`);
}

console.log("готово");
