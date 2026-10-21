/** Тонкая обёртка над D1: везде готовые запросы, не больше 50 на вызов. */

import type { Env } from "./types";

export async function one<T>(
  env: Env,
  sql: string,
  ...params: unknown[]
): Promise<T | null> {
  return await env.DB.prepare(sql)
    .bind(...params)
    .first<T>();
}

export async function many<T>(
  env: Env,
  sql: string,
  ...params: unknown[]
): Promise<T[]> {
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
  return await env.DB.prepare(sql)
    .bind(...params)
    .run();
}

export function prepare(
  env: Env,
  sql: string,
  ...params: unknown[]
): D1PreparedStatement {
  return env.DB.prepare(sql).bind(...params);
}

/** Батч экономит квоту: один вызов вместо N. */
export async function batch(
  env: Env,
  statements: D1PreparedStatement[],
): Promise<void> {
  if (!statements.length) return;
  for (let i = 0; i < statements.length; i += 25) {
    await env.DB.batch(statements.slice(i, i + 25));
  }
}

export async function logEvent(
  env: Env,
  type: string,
  userId: number | null,
  details: string,
): Promise<void> {
  await run(
    env,
    "INSERT INTO events (type, user_id, details) VALUES (?, ?, ?)",
    type,
    userId,
    details.slice(0, 400),
  );
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
