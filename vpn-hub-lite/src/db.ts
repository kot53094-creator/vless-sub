/**
 * Тонкая обёртка над базой: везде готовые запросы, не больше 50 на вызов.
 *
 * По умолчанию работает D1. Если заданы TURSO_URL и TURSO_TOKEN, ВСЕ
 * операции (чтение и запись) идут в Turso/libSQL: иначе записи остались бы
 * в D1, а чтения ушли в Turso, и данные разошлись бы. Переключение — это
 * пара секретов, код менять не нужно (см. docs/MIGRATION.md).
 */

import type { Env } from "./types";
import { tBatch, tMany, tOne, tRun, tursoEnabled } from "./turso";

/** Переносимое выражение: одинаково исполняется и в D1, и в Turso. */
export interface SqlStatement {
  sql: string;
  params: unknown[];
}

export async function one<T>(
  env: Env,
  sql: string,
  ...params: unknown[]
): Promise<T | null> {
  if (tursoEnabled(env)) return await tOne<T>(env, sql, ...params);
  return await env.DB.prepare(sql)
    .bind(...params)
    .first<T>();
}

export async function many<T>(
  env: Env,
  sql: string,
  ...params: unknown[]
): Promise<T[]> {
  if (tursoEnabled(env)) return await tMany<T>(env, sql, ...params);
  const result = await env.DB.prepare(sql)
    .bind(...params)
    .all<T>();
  return result.results ?? [];
}

export async function run(
  env: Env,
  sql: string,
  ...params: unknown[]
): Promise<D1Result> {
  if (tursoEnabled(env)) {
    await tRun(env, sql, ...params);
    // Вызывающие проверяют только успешность; meta у Turso не нужна.
    return { success: true, meta: {} } as unknown as D1Result;
  }
  return await env.DB.prepare(sql)
    .bind(...params)
    .run();
}

/** Батч экономит квоту: один вызов вместо N. */
export async function batch(
  env: Env,
  statements: SqlStatement[],
): Promise<void> {
  if (!statements.length) return;
  if (tursoEnabled(env)) {
    await tBatch(env, statements);
    return;
  }
  for (let i = 0; i < statements.length; i += 25) {
    await env.DB.batch(
      statements
        .slice(i, i + 25)
        .map((item) => env.DB.prepare(item.sql).bind(...item.params)),
    );
  }
}

export async function logEvent(
  env: Env,
  type: string,
  userId: number | null,
  details: string,
): Promise<void> {
  // Журнал событий — диагностика, а не данные пользователя. При исчерпанной
  // квоте D1 (или недоступной резервной базе) запись в events падает, и без
  // этого try/catch человек не получил бы продление из-за сбоя журнала.
  try {
    await run(
      env,
      "INSERT INTO events (type, user_id, details) VALUES (?, ?, ?)",
      type,
      userId,
      details.slice(0, 400),
    );
  } catch {
    // Событие потеряется — доступ важнее.
  }
}

export function nowIso(): string {
  return new Date().toISOString().replace("T", " ").slice(0, 19);
}

export function hoursAgoIso(hours: number): string {
  return new Date(Date.now() - hours * 3600_000)
    .toISOString()
    .replace("T", " ")
    .slice(0, 19);
}

export function daysFromNowIso(days: number): string {
  return new Date(Date.now() + days * 86400_000)
    .toISOString()
    .replace("T", " ")
    .slice(0, 19);
}

export function daysLeft(expiresAt: string | null): number | null {
  if (!expiresAt) return null;
  const ts = Date.parse(expiresAt.includes("T") ? expiresAt : expiresAt + "Z");
  if (Number.isNaN(ts)) return null;
  return Math.ceil((ts - Date.now()) / 86400_000);
}
