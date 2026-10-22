/**
 * Обслуживание данных по расписанию.
 *
 * Доступ по подписке и так перекрывается проверкой даты в sub.ts, но статус
 * в базе оставался 'active' — из-за этого дашборд считал истёкших активными,
 * а уведомления не понимали, кому писать. Здесь приводим данные в порядок.
 */

import { logEvent, run } from "./db";
import type { Env } from "./types";

/** Переводит просроченные подписки в статус expired. */
export async function expireSubscriptions(env: Env): Promise<number> {
  const result = await run(
    env,
    `UPDATE users
        SET status = 'expired'
      WHERE status = 'active'
        AND expires_at IS NOT NULL
        AND expires_at < datetime('now')`,
  );
  const count = result.meta.changes ?? 0;
  if (count) await logEvent(env, "expire", null, `подписок истекло: ${count}`);
  return count;
}
