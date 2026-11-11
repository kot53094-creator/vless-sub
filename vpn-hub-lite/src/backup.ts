/**
 * Ежедневный бэкап базы в Telegram.
 *
 * Зачем: D1 живёт в одном аккаунте Cloudflare. Ошибка в миграции, случайное
 * `DELETE`, блокировка аккаунта — и вся база людей, ключей и назначений
 * исчезает. `wrangler d1 export` требует CLI и запуска с ПК, а ПК выключен
 * большую часть суток. Поэтому дамп собирается внутри воркера по крону и
 * уходит документом в личный чат админа — это отдельное хранилище, которое
 * не зависит от Cloudflare.
 *
 * Что внутри: только таблицы данных (люди, источники, серверы, назначения,
 * настройки, пулы). В дампе есть ссылки и токены подписки — иначе восстановить
 * доступ было бы нечем, поэтому файл уходит только админу из ADMIN_TG_ID.
 */

import { many } from "./db";
import { logEvent } from "./db";
import { adminId, tgMultipart } from "./bot/telegram";
import type { Env } from "./types";

/**
 * Таблицы в порядке восстановления: сначала справочники, потом связи.
 * Нет таблицы (старая схема) — пропускаем, бэкап не должен падать целиком.
 */
const TABLES = [
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

export interface BackupResult {
  ok: boolean;
  skipped?: boolean;
  rows: number;
  bytes: number;
  error?: string;
}

export async function runBackup(env: Env, force = false): Promise<BackupResult> {
  const day = new Date().toISOString().slice(0, 10);
  const flag = `backup:${day}`;

  // Один бэкап в сутки: крон может сработать дважды, а 2 МБ в чат — лишнее.
  if (!force && (await env.CACHE.get(flag))) {
    return { ok: true, skipped: true, rows: 0, bytes: 0 };
  }

  const tables: Record<string, unknown[]> = {};
  let rows = 0;
  for (const table of TABLES) {
    try {
      const data = await many<Record<string, unknown>>(env, `SELECT * FROM ${table}`);
      tables[table] = data;
      rows += data.length;
    } catch {
      // Таблицы может не быть в этой версии схемы — это не ошибка.
    }
  }

  if (rows === 0) {
    return { ok: false, rows: 0, bytes: 0, error: "пустой дамп" };
  }

  const body = JSON.stringify(
    { version: 1, created_at: new Date().toISOString(), tables },
    null,
    0,
  );
  const bytes = new TextEncoder().encode(body).byteLength;

  const form = new FormData();
  form.append("chat_id", adminId(env));
  form.append(
    "caption",
    `Бэкап базы · ${day}\nстрок: ${rows} · ${(bytes / 1024).toFixed(0)} КБ\n` +
      `восстановление: node tools/restore-backup.mjs <файл> --apply`,
  );
  form.append(
    "document",
    new Blob([body], { type: "application/json" }),
    `vpn-hub-backup-${day}.json`,
  );

  const result = await tgMultipart(env, "sendDocument", form);
  if (!result.ok) {
    return { ok: false, rows, bytes, error: result.description ?? "telegram error" };
  }

  await env.CACHE.put(flag, "1", { expirationTtl: 3 * 24 * 3600 });
  await logEvent(env, "backup", null, `${rows} строк, ${(bytes / 1024).toFixed(0)} КБ`);
  return { ok: true, rows, bytes };
}
