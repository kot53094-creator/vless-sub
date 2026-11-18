/**
 * Экспорт базы «Апельсинка VPN» для переноса на другого провайдера.
 *
 * Забирает дамп у воркера (`/api/export`), проверяет, что критичные таблицы
 * не пусты, и сохраняет файл. Для SQL-дампа сразу выбирается диалект:
 * sqlite — Turso/libSQL, postgres — Neon/Supabase.
 *
 * Примеры:
 *   node tools/portable-export.mjs --url https://worker --token XXX
 *   node tools/portable-export.mjs --url https://worker --token XXX --format sql --dialect postgres
 *   node tools/portable-export.mjs --url https://worker --token XXX --scope all --out backups/full.json
 *
 * Токен можно не писать в командной строке: CHECK_TOKEN берётся из окружения.
 * В дампе есть токены подписок и ссылки источников — файл не коммитить.
 */

import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";

const args = process.argv.slice(2);
const flag = (name, fallback = "") => {
  const index = args.indexOf(`--${name}`);
  return index >= 0 ? (args[index + 1] ?? "") : fallback;
};
const has = (name) => args.includes(`--${name}`);

const base = (flag("url") || process.env.WORKER_URL || "").replace(/\/+$/, "");
const token = flag("token") || process.env.CHECK_TOKEN || "";
const scope = flag("scope", "critical");
const format = flag("format", "json");
const dialect = flag("dialect", "sqlite");

if (!base) {
  console.error("нужен --url https://<воркер> (или WORKER_URL)");
  process.exit(1);
}
if (!token) {
  console.error("нужен --token (или CHECK_TOKEN в окружении)");
  process.exit(1);
}
if (!["critical", "all"].includes(scope)) {
  console.error("--scope: critical или all");
  process.exit(1);
}
if (!["json", "sql"].includes(format)) {
  console.error("--format: json или sql");
  process.exit(1);
}
if (!["sqlite", "postgres"].includes(dialect)) {
  console.error("--dialect: sqlite или postgres");
  process.exit(1);
}

const stamp = new Date().toISOString().slice(0, 10);
const out =
  flag("out") ||
  resolve(
    "backups",
    `apelsinka-${scope}-${stamp}.${format === "sql" ? "sql" : "json"}`,
  );

const url =
  `${base}/api/export?tables=${scope}&format=${format}&dialect=${dialect}`;
const response = await fetch(url, {
  headers: { "x-check-token": token, accept: "*/*" },
});
if (!response.ok) {
  const body = (await response.text()).slice(0, 300);
  console.error(`экспорт не удался: HTTP ${response.status} ${body}`);
  process.exit(1);
}
const body = await response.text();
if (!body.trim()) {
  console.error("пустой ответ: база недоступна или экспорт отключён");
  process.exit(1);
}

mkdirSync(dirname(out), { recursive: true });
writeFileSync(out, body, "utf8");

if (format === "sql") {
  const statements = (body.match(/INSERT /g) ?? []).length;
  console.log(`SQL-дамп: ${out}`);
  console.log(`диалект: ${dialect}, INSERT: ${statements}, размер: ${body.length} байт`);
  process.exit(0);
}

let payload;
try {
  payload = JSON.parse(body);
} catch (error) {
  console.error(`ответ не JSON: ${error.message}`);
  process.exit(1);
}

const manifest = payload.manifest ?? {};
const tables = payload.tables ?? {};
const critical = ["settings", "sources", "servers", "users", "plans", "payments", "promos", "referrals"];
const empty = critical.filter((name) => !Array.isArray(tables[name]) || tables[name].length === 0);

console.log(`JSON-дамп: ${out}`);
console.log(
  `строк: ${manifest.rows ?? "?"}, таблиц: ${Object.keys(tables).length}, источник: ${manifest.source ?? "?"}`,
);
if (payload.skipped?.length) console.log(`пропущено: ${payload.skipped.join(", ")}`);
if (payload.truncated?.length) console.log(`обрезано: ${payload.truncated.join(", ")} (лимит строк)`);
if (empty.length) {
  console.error(`критичные таблицы пусты: ${empty.join(", ")}`);
  if (has("verify")) process.exit(1);
} else {
  console.log("критичные таблицы на месте");
}

// Проверка, что файл читается восстановлением: структура tables — объект.
if (has("verify")) {
  if (!payload.tables || typeof payload.tables !== "object") {
    console.error("нет поля tables — restore-backup.mjs такой файл не примет");
    process.exit(1);
  }
  console.log("проверка структуры пройдена");
}
