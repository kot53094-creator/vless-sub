/**
 * Версии персональной подписки и откат.
 *
 * Смысл: набор серверов у человека меняется сам (sync, проверки, лимиты).
 * Если после обновления стало хуже — нужно вернуть предыдущий рабочий
 * набор, а не «пересобрать как получится». Поэтому при каждом изменении
 * состава сохраняется снимок id серверов, а последняя версия никогда не
 * удаляется: даже неудачный прогон не оставляет человека без подписки.
 *
 * Храним только id — ссылки и UUID остаются в servers, дублировать секреты
 * в истории незачем.
 */

import { many, one, run, logEvent } from "./db";
import type { Env, UserRow } from "./types";

export interface SubVersionRow {
  id: number;
  user_id: number;
  version: number;
  fingerprint: string;
  server_ids: string;
  count: number;
  created_at: string;
  note: string;
}

/** Сколько версий держим на человека: больше не нужно, D1 не резиновый. */
const KEEP_VERSIONS = 30;

/** Стабильный порядок и никаких повторов — иначе версии «дрожат». */
export function stableIds(ids: number[]): number[] {
  return [...new Set(ids.filter((id) => Number.isInteger(id) && id > 0))].sort((a, b) => a - b);
}

/** Отпечаток состава: по нему понимаем, изменилось ли что-то вообще. */
export function fingerprintOf(ids: number[]): string {
  return stableIds(ids).join(",");
}

export function parseIds(raw: string): number[] {
  return stableIds(
    raw
      .split(",")
      .map((part) => Number(part.trim()))
      .filter((value) => Number.isFinite(value)),
  );
}

/**
 * Записать новую версию, если состав отличается от предыдущей.
 * Возвращает номер актуальной версии и признак «была ли запись».
 */
export async function recordVersion(
  env: Env,
  user: UserRow,
  ids: number[],
  note = "",
): Promise<{ version: number; created: boolean } | null> {
  const clean = stableIds(ids);
  if (!clean.length) return null;

  const fingerprint = fingerprintOf(clean);
  const last = await one<SubVersionRow>(
    env,
    "SELECT * FROM sub_versions WHERE user_id = ? ORDER BY id DESC LIMIT 1",
    user.id,
  );
  if (last && last.fingerprint === fingerprint) {
    return { version: last.version, created: false };
  }

  const version = (last?.version ?? 0) + 1;
  await run(
    env,
    `INSERT INTO sub_versions (user_id, version, fingerprint, server_ids, count, note)
     VALUES (?, ?, ?, ?, ?, ?)`,
    user.id,
    version,
    fingerprint,
    clean.join(","),
    clean.length,
    note.slice(0, 120),
  );

  if (version > KEEP_VERSIONS) {
    await run(
      env,
      "DELETE FROM sub_versions WHERE user_id = ? AND version <= ?",
      user.id,
      version - KEEP_VERSIONS,
    );
  }

  await logEvent(env, "sub_version", user.id, `версия ${version}: серверов ${clean.length}`);
  return { version, created: true };
}

export async function listVersions(
  env: Env,
  userId: number,
  limit = 20,
): Promise<SubVersionRow[]> {
  return await many<SubVersionRow>(
    env,
    "SELECT * FROM sub_versions WHERE user_id = ? ORDER BY version DESC LIMIT ?",
    userId,
    Math.min(100, Math.max(1, limit)),
  );
}

/** Свежие версии по всем людям — обзор на странице админки. */
export async function recentVersions(
  env: Env,
  limit = 40,
): Promise<Array<SubVersionRow & { tg_id: string }>> {
  return await many<SubVersionRow & { tg_id: string }>(
    env,
    `SELECT v.*, u.tg_id FROM sub_versions v
       JOIN users u ON u.id = v.user_id
      ORDER BY v.id DESC LIMIT ?`,
    Math.min(100, Math.max(1, limit)),
  );
}

export interface RollbackResult {
  ok: boolean;
  count: number;
  error: string;
}

/**
 * Вернуть человеку состав конкретной версии.
 *
 * Сервер мог исчезнуть из источника, поэтому берём только те id, что ещё
 * есть в базе. Если не осталось ни одного — откат отменяем целиком, чтобы
 * не оставить пустую подписку.
 */
export async function rollbackVersion(
  env: Env,
  user: UserRow,
  versionId: number,
): Promise<RollbackResult> {
  const row = await one<SubVersionRow>(
    env,
    "SELECT * FROM sub_versions WHERE id = ? AND user_id = ?",
    versionId,
    user.id,
  );
  if (!row) return { ok: false, count: 0, error: "версия не найдена" };

  const wanted = parseIds(row.server_ids);
  if (!wanted.length) return { ok: false, count: 0, error: "в версии нет серверов" };

  const placeholders = wanted.map(() => "?").join(",");
  const alive = await many<{ id: number }>(
    env,
    `SELECT id FROM servers WHERE id IN (${placeholders})`,
    ...wanted,
  );
  const ids = stableIds(alive.map((server) => server.id));
  if (!ids.length) {
    return { ok: false, count: 0, error: "серверы этой версии больше не существуют" };
  }

  const keep = ids.map(() => "?").join(",");
  await run(
    env,
    `DELETE FROM assignments WHERE user_id = ? AND server_id NOT IN (${keep})`,
    user.id,
    ...ids,
  );
  await run(
    env,
    `INSERT OR IGNORE INTO assignments (user_id, server_id)
     SELECT ?, id FROM servers WHERE id IN (${keep})`,
    user.id,
    ...ids,
  );

  await run(
    env,
    `INSERT INTO sub_versions (user_id, version, fingerprint, server_ids, count, note)
     SELECT ?, COALESCE(MAX(version), 0) + 1, ?, ?, ?, ?
       FROM sub_versions WHERE user_id = ?`,
    user.id,
    fingerprintOf(ids),
    ids.join(","),
    ids.length,
    `откат на v${row.version}`,
    user.id,
  );

  await invalidate(env, user);
  await logEvent(env, "rollback", user.id, `откат на версию ${row.version}: серверов ${ids.length}`);
  return { ok: true, count: ids.length, error: "" };
}

/** Сброс кэша подписки без импорта sub.ts — чтобы не плодить цикл модулей. */
async function invalidate(env: Env, user: UserRow): Promise<void> {
  for (const key of [`sub:v1:${user.sub_token}`, `sub:v2:${user.sub_token}`, `sub:v3:${user.sub_token}`]) {
    await env.CACHE.delete(key);
  }
}

