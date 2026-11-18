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

/**
 * Удаляет старые записи об устройствах.
 *
 * Зачем: лимит устройств считается по активным записям. Если человек за год
 * сменил три телефона и два клиента, в базе остаются «мёртвые» устройства,
 * которые никто не отвязывал, и они занимают место в лимите. Через 30 дней
 * без обращений запись удаляется — вернувшееся устройство просто
 * зарегистрируется заново.
 *
 * Заблокированные записи живут дольше (90 дней): человек мог отвязать
 * устройство намеренно, и через день оно не должно снова занять слот.
 */
export async function pruneDevices(env: Env): Promise<number> {
  let removed = 0;
  try {
    const stale = await run(
      env,
      `DELETE FROM user_devices
        WHERE blocked = 0 AND last_seen < datetime('now', '-30 days')`,
    );
    removed += stale.meta?.changes ?? 0;
  } catch {
    // старая схема без blocked_reason — не повод падать
  }
  try {
    const blocked = await run(
      env,
      `DELETE FROM user_devices
        WHERE blocked = 1 AND last_seen < datetime('now', '-90 days')`,
    );
    removed += blocked.meta?.changes ?? 0;
  } catch {
    // без блокировок
  }
  if (removed) await logEvent(env, "devices_pruned", null, `удалено записей: ${removed}`);
  return removed;
}
