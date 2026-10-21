/**
 * Распределение людей по серверам.
 *
 * Правила: берём только живые серверы из shareable-источников (paid_private
 * исключён всегда), не превышаем max_users, сортируем по загрузке.
 */

import { batch, logEvent, many, one, prepare, run } from "./db";
import type { Env, ServerRow } from "./types";

export interface Candidate {
  id: number;
  load: number;
  max_users: number;
  latency_ms: number | null;
}

function ratio(candidate: Candidate): number {
  return candidate.max_users > 0 ? candidate.load / candidate.max_users : 1;
}

/** Чистая функция: какие серверы выдать. Используется в тестах. */
export function rankCandidates(candidates: Candidate[], count: number): number[] {
  return [...candidates]
    .filter((c) => c.max_users <= 0 || c.load < c.max_users)
    .sort(
      (a, b) =>
        ratio(a) - ratio(b) ||
        (a.latency_ms ?? 9999) - (b.latency_ms ?? 9999) ||
        a.id - b.id,
    )
    .slice(0, Math.max(0, count))
    .map((c) => c.id);
}

const CANDIDATE_SQL = `
  SELECT s.id,
         s.max_users,
         s.latency_ms,
         (SELECT COUNT(*) FROM assignments a WHERE a.server_id = s.id) AS load
  FROM servers s
  JOIN sources src ON src.id = s.source_id
  WHERE s.status IN ('alive', 'unknown')
    AND src.visibility = 'shareable'
    AND src.kind <> 'paid_private'
    AND EXISTS (
      SELECT 1 FROM user_pools up
      JOIN pool_servers ps ON ps.pool_id = up.pool_id
      WHERE up.user_id = ?1 AND ps.server_id = s.id
    )
    AND s.id NOT IN (SELECT server_id FROM assignments WHERE user_id = ?1)
    AND (
      src.max_devices = 0
      OR EXISTS (SELECT 1 FROM user_sources us WHERE us.user_id = ?1 AND us.source_id = src.id)
      OR (SELECT COUNT(*) FROM user_sources x WHERE x.source_id = src.id) < src.max_devices
    )
`;

/** Выдать серверы, если у человека ещё ничего нет. */
export async function assignIfEmpty(env: Env, userId: number, count: number): Promise<number> {
  const existing = await one<{ n: number }>(
    env,
    "SELECT COUNT(*) AS n FROM assignments WHERE user_id = ?",
    userId,
  );
  if ((existing?.n ?? 0) > 0) return 0;

  // Если админ не назначил группы — считаем, что доступны все.
  const pools = await one<{ n: number }>(
    env,
    "SELECT COUNT(*) AS n FROM user_pools WHERE user_id = ?",
    userId,
  );
  if ((pools?.n ?? 0) === 0) {
    await run(
      env,
      "INSERT OR IGNORE INTO user_pools (user_id, pool_id) SELECT ?, id FROM pools",
      userId,
    );
  }
  return (await assignForUser(env, userId, count)).length;
}

export async function candidatesForUser(
  env: Env,
  userId: number,
): Promise<Candidate[]> {
  return await many<Candidate>(env, CANDIDATE_SQL, userId);
}

/** Выдать пользователю до `count` серверов. Возвращает id выданных. */
export async function assignForUser(
  env: Env,
  userId: number,
  count: number,
): Promise<number[]> {
  const candidates = await candidatesForUser(env, userId);
  const picked = rankCandidates(candidates, count);
  if (!picked.length) return [];

  await batch(
    env,
    picked.map((serverId) =>
      prepare(
        env,
        "INSERT OR IGNORE INTO assignments (user_id, server_id) VALUES (?, ?)",
        userId,
        serverId,
      ),
    ),
  );
  // Занимаем слот на лимитированных источниках (например, платный ключ на 3 устройства)
  const sourcesUsed = await many<{ source_id: number; max_devices: number }>(
    env,
    `SELECT DISTINCT s.source_id, src.max_devices
     FROM servers s JOIN sources src ON src.id = s.source_id
     WHERE s.id IN (${picked.map(() => "?").join(",")})`,
    ...picked,
  );
  for (const item of sourcesUsed) {
    if (item.max_devices > 0) {
      await run(
        env,
        "INSERT OR IGNORE INTO user_sources (user_id, source_id) VALUES (?, ?)",
        userId,
        item.source_id,
      );
    }
  }

  await logEvent(env, "assign", userId, `выдано серверов: ${picked.join(", ")}`);
  return picked;
}

/**
 * Добрать до целевого числа, а не «добавить ещё N».
 * Нужно после загрузки новых ключей: старые пользователи не должны
 * оставаться без новых серверов и не должны получать лишние.
 */
export async function topUpUser(env: Env, userId: number, target: number): Promise<number> {
  const current = await assignmentCount(env, userId);
  const missing = Math.max(0, target - current);
  if (missing === 0) return 0;
  const picked = await assignForUser(env, userId, missing);
  return picked.length;
}

/** Сколько серверов у пользователя сейчас. */
export async function assignmentCount(env: Env, userId: number): Promise<number> {
  const row = await many<{ n: number }>(
    env,
    "SELECT COUNT(*) AS n FROM assignments WHERE user_id = ?",
    userId,
  );
  return row[0]?.n ?? 0;
}

/**
 * Заменить мёртвый сервер у всех, кому он выдан.
 * Возвращает список пользователей, которых нужно уведомить.
 */
export async function replaceDeadServer(
  env: Env,
  deadServerId: number,
): Promise<number[]> {
  const affected = await many<{ user_id: number }>(
    env,
    "SELECT user_id FROM assignments WHERE server_id = ?",
    deadServerId,
  );

  const notified: number[] = [];
  for (const { user_id } of affected) {
    const candidates = (await candidatesForUser(env, user_id)).filter(
      (c) => c.id !== deadServerId,
    );
    const [replacement] = rankCandidates(candidates, 1);
    if (!replacement) continue;

    await run(
      env,
      "UPDATE assignments SET server_id = ?, assigned_at = datetime('now') WHERE user_id = ? AND server_id = ?",
      replacement,
      user_id,
      deadServerId,
    );
    await logEvent(env, "replace", user_id, `сервер ${deadServerId} → ${replacement}`);
    notified.push(user_id);
  }
  return notified;
}

/** Выровнять загрузку: переносим часть назначений с самых полных серверов. */
export async function rebalance(env: Env, maxMoves = 20): Promise<number> {
  const loads = await many<Candidate & { status: string }>(
    env,
    `SELECT s.id, s.max_users, s.latency_ms,
            (SELECT COUNT(*) FROM assignments a WHERE a.server_id = s.id) AS load
     FROM servers s
     JOIN sources src ON src.id = s.source_id
     WHERE s.status IN ('alive', 'unknown') AND src.visibility = 'shareable' AND src.kind <> 'paid_private'`,
  );

  let moves = 0;
  for (const hot of loads.filter((s) => ratio(s) >= 0.9)) {
    if (moves >= maxMoves) break;
    const cold = loads
      .filter((s) => ratio(s) < 0.6 && s.id !== hot.id)
      .sort((a, b) => ratio(a) - ratio(b));
    if (!cold.length) break;

    const users = await many<{ user_id: number }>(
      env,
      `SELECT a.user_id FROM assignments a
       WHERE a.server_id = ?
         AND (SELECT COUNT(*) FROM assignments b WHERE b.user_id = a.user_id) > 1
       LIMIT 5`,
      hot.id,
    );

    for (const user of users) {
      if (moves >= maxMoves) break;
      const target = cold[0];
      if (!target) break;
      if (target.load + 1 > target.max_users) continue;

      await run(
        env,
        "UPDATE assignments SET server_id = ?, assigned_at = datetime('now') WHERE user_id = ? AND server_id = ?",
        target.id,
        user.user_id,
        hot.id,
      );
      await logEvent(
        env,
        "rebalance",
        user.user_id,
        `перенос ${hot.id} → ${target.id}`,
      );
      hot.load -= 1;
      target.load += 1;
      moves += 1;
    }
  }
  return moves;
}

export interface ServerLoad extends ServerRow {
  load: number;
  source_name: string;
  source_kind: string;
  visibility: string;
}

export async function serverLoads(env: Env, limit = 50): Promise<ServerLoad[]> {
  return await many<ServerLoad>(
    env,
    `SELECT s.*, src.name AS source_name, src.kind AS source_kind, src.visibility,
            (SELECT COUNT(*) FROM assignments a WHERE a.server_id = s.id) AS load
     FROM servers s JOIN sources src ON src.id = s.source_id
     ORDER BY (CAST((SELECT COUNT(*) FROM assignments a WHERE a.server_id = s.id) AS REAL) / s.max_users) DESC
     LIMIT ?`,
    limit,
  );
}
