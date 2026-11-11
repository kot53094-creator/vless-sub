/**
 * Восстановление JSON-бэкапа из Telegram в D1 (или в любой SQLite).
 *
 * Бот раз в сутки присылает админу `vpn-hub-backup-YYYY-MM-DD.json`. Это
 * JSON, а не SQL, поэтому `wrangler d1 execute --file` его не понимает.
 * Скрипт превращает дамп в SQL и (по флагу --apply) сразу применяет к D1.
 *
 * Запуск:
 *   node tools/restore-backup.mjs vpn-hub-backup-2026-11-11.json
 *   node tools/restore-backup.mjs vpn-hub-backup-2026-11-11.json --apply
 *
 * Переменные окружения:
 *   D1_NAME      имя базы (по умолчанию vpn-hub-lite)
 *   RESTORE_OUT  путь к SQL-файлу (по умолчанию backups/restore-<дата>.sql)
 *
 * Безопасность: в дампе есть токены подписок и ссылки источников. Файл и
 * сгенерированный SQL нельзя коммитить в публичный репозиторий — каталог
 * backups/ уже в .gitignore.
 *
 * Восстанавливать лучше в пустую базу: скрипт использует INSERT OR REPLACE,
 * он не удаляет строки, которых не было в дампе.
 */

import { execFileSync } from "node:child_process";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";

// Порядок восстановления: справочники → пользователи → связи.
// Неизвестные таблицы идут в конец по алфавиту, чтобы ничего не потерять.
const ORDER = [
  "settings",
  "sources",
  "pools",
  "servers",
  "pool_servers",
  "users",
  "user_pools",
  "user_sources",
  "assignments",
  "plans",
  "payments",
  "promos",
  "promo_uses",
  "accruals",
  "daily_claims",
  "referrals",
  "invites",
  "user_devices",
  "user_squads",
  "sub_versions",
  "banners",
  "notify_log",
];

function fail(message) {
  console.error(`ошибка: ${message}`);
  process.exit(1);
}

function ident(name) {
  return `"${String(name).replace(/"/g, '""')}"`;
}

function literal(value) {
  if (value === null || value === undefined) return "NULL";
  if (typeof value === "number") {
    if (!Number.isFinite(value)) fail("в дампе нечисловое число (NaN/Infinity)");
    return String(value);
  }
  if (typeof value === "boolean") return value ? "1" : "0";
  if (typeof value === "object") {
    return `'${JSON.stringify(value).replace(/'/g, "''")}'`;
  }
  return `'${String(value).replace(/'/g, "''")}'`;
}

function tableOrder(a, b) {
  const ia = ORDER.indexOf(a);
  const ib = ORDER.indexOf(b);
  if (ia === -1 && ib === -1) return a.localeCompare(b);
  if (ia === -1) return 1;
  if (ib === -1) return -1;
  return ia - ib;
}

const args = process.argv.slice(2);
const file = args.find((arg) => !arg.startsWith("--"));
const apply = args.includes("--apply");
if (!file) {
  fail("укажите путь к JSON-бэкапу: node tools/restore-backup.mjs <файл> [--apply]");
}

let payload;
try {
  payload = JSON.parse(readFileSync(file, "utf8"));
} catch (error) {
  fail(`не читается JSON: ${error.message}`);
}
if (!payload || typeof payload !== "object" || typeof payload.tables !== "object") {
  fail("это не бэкап vpn-hub: нет поля tables");
}

const tables = Object.keys(payload.tables).sort(tableOrder);
const lines = [
  `-- Восстановление бэкапа от ${payload.created_at ?? "неизвестно"}`,
  "-- Сгенерировано tools/restore-backup.mjs. В файле есть секреты!",
  "PRAGMA foreign_keys = OFF;",
  "BEGIN;",
];
let total = 0;

for (const table of tables) {
  const rows = payload.tables[table];
  if (!Array.isArray(rows) || rows.length === 0) continue;
  lines.push(`-- ${table}: ${rows.length}`);
  for (const row of rows) {
    if (!row || typeof row !== "object" || Array.isArray(row)) {
      fail(`таблица ${table}: строка не объект`);
    }
    const columns = Object.keys(row);
    if (!columns.length) continue;
    lines.push(
      `INSERT OR REPLACE INTO ${ident(table)} (${columns.map(ident).join(", ")}) VALUES (${columns
        .map((column) => literal(row[column]))
        .join(", ")});`,
    );
    total += 1;
  }
}

lines.push("COMMIT;", "PRAGMA foreign_keys = ON;", "");

const out = resolve(
  process.env.RESTORE_OUT ?? `backups/restore-${payload.created_at?.slice(0, 10) ?? "backup"}.sql`,
);
mkdirSync(dirname(out), { recursive: true });
writeFileSync(out, lines.join("\n"), "utf8");
console.log(`SQL готов: ${out}`);
console.log(`таблиц: ${tables.length}, строк: ${total}`);

if (apply) {
  const dbName = process.env.D1_NAME ?? "vpn-hub-lite";
  console.log(`Применяю в D1 «${dbName}» (--remote)…`);
  execFileSync("npx", ["wrangler", "d1", "execute", dbName, "--remote", "--file", out], {
    stdio: "inherit",
  });
  console.log("готово");
}
