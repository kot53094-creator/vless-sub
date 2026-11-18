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
import type { OrderRow, PaidEvent } from "./pay/types";

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

/**
 * Денежная строка журнала для онлайн-оплаты.
 *
 * `payments` — бухгалтерский след, `orders` — состояние оплаты. Строка
 * создаётся один раз: повторный вызов по тому же заказу пропускается, иначе
 * повторная доставка вебхука удвоила бы выручку в отчёте.
 */
export async function recordsPayment(
  env: Env,
  order: OrderRow,
  event: PaidEvent,
): Promise<void> {
  try {
    const exists = await run(
      env,
      `INSERT INTO payments
         (user_id, kind, days, note, plan_code, amount_rub, currency, method, status, external_id, actor, paid_at)
       SELECT ?, 'online', ?, ?, ?, ?, ?, ?, 'paid', ?, 'checkout', datetime('now')
        WHERE NOT EXISTS (
          SELECT 1 FROM payments WHERE external_id = ? AND method = ?
        )`,
      order.user_id,
      order.days,
      `${order.plan_title} · ${order.provider}`.slice(0, 200),
      order.plan_code,
      order.amount_rub,
      order.currency,
      order.provider,
      event.externalId,
      event.externalId,
      order.provider,
    );
    void exists;
  } catch {
    // Журнал не должен ломать выдачу: заказ уже оплачен.
  }
}
