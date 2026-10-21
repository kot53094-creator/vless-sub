/**
 * Выдача новых серверов людям.
 *
 * Отдельный модуль, чтобы не было цикла balance ↔ sub: здесь встречаются
 * назначения (balance) и сброс кэша подписки (sub).
 */

import { logEvent, many, one, run } from "./db";
import { topUpUser } from "./balance";
import { invalidateSubscription } from "./sub";
import type { Env } from "./types";

/**
 * Доводит у всех активных пользователей число серверов до SERVERS_PER_USER
 * и сбрасывает кэш их подписок. Возвращает, сколько связей добавлено.
 */
export async function topUpAllActive(env: Env, target?: number): Promise<number> {
  const per = target ?? Math.max(1, Number(env.SERVERS_PER_USER ?? "15") || 15);
  const users = await many<{ id: number; sub_token: string }>(
    env,
    "SELECT id, sub_token FROM users WHERE status = 'active' LIMIT 100",
  );

  let added = 0;
  for (const user of users) {
    added += await topUpUser(env, user.id, per);
    await invalidateSubscription(env, user.sub_token);
  }
  return added;
}

/**
 * Раздаёт серверы конкретного источника.
 *
 * Приватный источник (свои/оплаченные ключи) отдаётся только владельцу —
 * и без ограничения «нормой», иначе свежие ключи не попадают в подписку,
 * когда у человека уже набрано SERVERS_PER_USER серверов.
 * Публичный — обычным доведением до нормы.
 */
export async function deliverSource(env: Env, sourceId: number): Promise<number> {
  const source = await one<{ visibility: string; max_devices: number }>(
    env,
    "SELECT visibility, max_devices FROM sources WHERE id = ?",
    sourceId,
  );
  if (!source) return 0;

  if (source.visibility !== "private") {
    return await topUpAllActive(env);
  }

  const owner = await one<{ id: number; sub_token: string; tg_id: string }>(
    env,
    "SELECT id, sub_token, tg_id FROM users WHERE tg_id = ?",
    String(env.ADMIN_TG_ID ?? "5680608085").trim(),
  );
  if (!owner) return 0;

  // Источник с лимитом устройств выдаётся только по слотам: без записи
  // в user_sources серверы не попадут в подписку даже владельцу.
  if (source.max_devices > 0) {
    await run(
      env,
      "INSERT OR IGNORE INTO user_sources (user_id, source_id) VALUES (?, ?)",
      owner.id,
      sourceId,
    );
  }

  const inserted = await run(
    env,
    `INSERT OR IGNORE INTO assignments (user_id, server_id)
     SELECT ?, id FROM servers WHERE source_id = ?`,
    owner.id,
    sourceId,
  );
  await invalidateSubscription(env, owner.sub_token);
  await logEvent(env, "deliver_private", owner.id, `источник #${sourceId}`);
  return inserted.meta.changes ?? 0;
}
