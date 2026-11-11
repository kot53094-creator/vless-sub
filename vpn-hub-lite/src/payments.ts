/**
 * Журнал выдачи подписок (payments из раздела 6 промта).
 *
 * Онлайн-оплаты нет — провайдер подключается только с явного подтверждения
 * владельца. Здесь остаются реальные события: ручные продления и одобрения
 * из бота и панели, чтобы у каждой строки users был бухгалтерский след.
 *
 * Запись не должна ломать саму выдачу: если таблицы ещё нет (миграция не
 * докатилась) или база недоступна — молча пропускаем, доступ человеку важнее.
 */

import { run } from "./db";
import type { Env } from "./types";

export type PaymentKind = "manual" | "promo" | "online";

export async function recordPayment(
  env: Env,
  userId: number,
  days: number,
  note: string,
  kind: PaymentKind = "manual",
): Promise<void> {
  if (!Number.isFinite(days) || days <= 0) return;
  try {
    await run(
      env,
      "INSERT INTO payments (user_id, kind, days, note) VALUES (?, ?, ?, ?)",
      userId,
      kind,
      Math.round(days),
      note.slice(0, 200),
    );
  } catch {
    // Журнал не должен ломать выдачу доступа.
  }
}
