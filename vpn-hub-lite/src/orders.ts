/**
 * Заказы и выдача доступа.
 *
 * Жизненный цикл:
 *   pending → paid → (refunded)
 *   pending → expired / canceled / failed
 *
 * Три правила, на которых держится вся платность:
 *
 * 1. Доступ выдаётся только после подтверждённой оплаты. Ни `pre_checkout`,
 *    ни редирект с сайта оплаты не являются доказательством: первый —
 *    разрешение списать, второй — просто возврат пользователя.
 * 2. Выдача идемпотентна дважды: условный `UPDATE ... WHERE status='pending'`
 *    не даёт обработать один платёж дважды, а `accruals.ref = order:<id>`
 *    не даёт начислить дни повторно, даже если первый шаг когда-нибудь
 *    откажет.
 * 3. Сумма сверяется с ценой заказа до выдачи. Проверку делает провайдер
 *    (см. `pay/index.ts`), а здесь сумма уже считается доверенной.
 *
 * Файл не ходит в Telegram и не знает про кнопки: только база и начисления.
 */

import { logEvent, many, one, run } from "./db";
import { applyAccrual } from "./bonus";
import { randomToken } from "./security";
import { recordsPayment } from "./payments";
import type { Env, UserRow } from "./types";
import type { OrderRow, OrderStatus, PaidEvent, PayPlan, ProviderId } from "./pay/types";
import { amountMinor, orderTtlHours, starsForPlan } from "./pay/money";

export const ORDER_COLUMNS = `id, public_id, user_id, plan_code, plan_title, days,
  device_limit, traffic_gb, amount_rub, amount_minor, currency, provider, status,
  external_id, telegram_charge_id, provider_charge_id, promo_code, note,
  created_at, updated_at, paid_at, refunded_at`;

/** Валютa по провайдеру: звёзды отдельно, всё остальное — рубли. */
export function currencyFor(provider: ProviderId): string {
  return provider === "stars" ? "XTR" : "RUB";
}

/** Платный ли тариф: 0 ₽ — это пробный/ручной, а не товар. */
/**
 * Пакет трафика: код вида `gb50`, ноль дней, цена в рублях.
 *
 * Такой заказ не продлевает подписку, а увеличивает квоту, поэтому обычная
 * проверка «дни > 0» его бы отклонила.
 */
export function isTrafficPack(planCode: string): boolean {
  return /^gb\d+$/.test(planCode);
}

export function isPurchasable(plan: PayPlan): boolean {
  return plan.price_rub > 0 && (plan.days > 0 || isTrafficPack(plan.code));
}

/**
 * Готова ли касса: применена ли миграция 0022.
 *
 * Код и база обновляются не одновременно. Если таблицы `orders` ещё нет,
 * витрина должна честно сказать «оплата не подключена», а не предлагать
 * кнопку, которая гарантированно упадёт. Результат кэшируется на 10 минут,
 * чтобы не тратить по запросу на каждого, кто открыл тарифы.
 */
export async function ordersReady(env: Env): Promise<boolean> {
  try {
    const cached = await env.CACHE.get("orders:ready");
    if (cached === "1") return true;
    if (cached === "0") return false;
  } catch {
    // без кэша обойдёмся
  }

  let ready = false;
  try {
    await one(env, "SELECT id FROM orders LIMIT 1");
    ready = true;
  } catch {
    ready = false;
  }

  try {
    await env.CACHE.put("orders:ready", ready ? "1" : "0", { expirationTtl: 600 });
  } catch {
    // кэш не обязателен
  }
  return ready;
}

export async function findOrder(env: Env, publicId: string): Promise<OrderRow | null> {
  return await one<OrderRow>(
    env,
    `SELECT ${ORDER_COLUMNS} FROM orders WHERE public_id = ?`,
    publicId,
  );
}

export async function findOrderById(env: Env, id: number): Promise<OrderRow | null> {
  return await one<OrderRow>(env, `SELECT ${ORDER_COLUMNS} FROM orders WHERE id = ?`, id);
}

export async function listOrders(
  env: Env,
  userId: number,
  limit = 10,
): Promise<OrderRow[]> {
  const safe = Math.min(Math.max(Math.trunc(limit) || 10, 1), 50);
  try {
    return await many<OrderRow>(
      env,
      `SELECT ${ORDER_COLUMNS} FROM orders WHERE user_id = ? ORDER BY id DESC LIMIT ?`,
      userId,
      safe,
    );
  } catch {
    return [];
  }
}

/**
 * Создать заказ в статусе pending.
 *
 * Заказ фиксирует цену и количество дней на момент покупки: если владелец
 * поменяет тариф, пока человек платит, тот получит то, что видел.
 */
export async function createOrder(
  env: Env,
  user: UserRow,
  plan: PayPlan,
  provider: ProviderId,
  note = "",
): Promise<{ ok: boolean; order?: OrderRow; error?: string }> {
  if (!isPurchasable(plan)) {
    return { ok: false, error: "Этот тариф нельзя купить" };
  }

  const currency = currencyFor(provider);
  // Для звёзд «минимальная единица» — сама звезда, поэтому в amount_minor
  // лежит цена в звёздах, а не в рублях: именно это число списывает Telegram,
  // и именно с ним сверяется successful_payment.
  const amount =
    provider === "stars" ? starsForPlan(plan, env) : amountMinor(plan.price_rub, currency);

  // public_id — единственное, что видит провайдер. Коллизия почти невозможна,
  // но при ней лучше повторить, чем отдать человеку ошибку оплаты.
  for (let attempt = 0; attempt < 3; attempt += 1) {
    const publicId = `ord_${randomToken(9)}`;
    try {
      await run(
        env,
        `INSERT INTO orders
           (public_id, user_id, plan_code, plan_title, days, device_limit, traffic_gb,
            amount_rub, amount_minor, currency, provider, status, note)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'pending', ?)`,
        publicId,
        user.id,
        plan.code,
        plan.title,
        plan.days,
        plan.device_limit ?? null,
        plan.traffic_gb ?? null,
        Math.round(plan.price_rub),
        amount,
        currency,
        provider,
        note.slice(0, 200),
      );
      const order = await findOrder(env, publicId);
      if (order) return { ok: true, order };
    } catch {
      // Уникальность public_id или недоступная база — пробуем ещё раз.
    }
  }
  return { ok: false, error: "Не удалось создать заказ. Попробуйте позже" };
}

/** Привязать внешний идентификатор платежа к уже созданному заказу. */
export async function attachExternalId(
  env: Env,
  orderId: number,
  externalId: string,
): Promise<void> {
  if (!externalId) return;
  try {
    await run(
      env,
      "UPDATE orders SET external_id = ?, updated_at = datetime('now') WHERE id = ? AND external_id IS NULL",
      externalId,
      orderId,
    );
  } catch {
    // Гонка двух одинаковых счетов: второй останется без external_id и
    // найдётся по payload при вебхуке.
  }
}

export interface PaidResult {
  ok: boolean;
  /** Платёж уже был обработан раньше — повторная доставка вебхука. */
  already: boolean;
  order: OrderRow | null;
  expiresAt?: string | null;
  error?: string;
}

/**
 * Отметить заказ оплаченным и выдать дни.
 *
 * Порядок намеренно такой: сначала атомарный переход статуса, потом
 * начисление. Если процесс умрёт между ними, повторный вебхук увидит
 * `status='paid'` и вернёт `already=true`, а человек останется без дней —
 * поэтому начисление идёт первым делом после перехода и обёрнуто так, чтобы
 * ошибка была видна в журнале, а не проглочена.
 */
export async function markOrderPaid(
  env: Env,
  publicId: string,
  event: PaidEvent,
): Promise<PaidResult> {
  const order = await findOrder(env, publicId);
  if (!order) return { ok: false, already: false, order: null, error: "заказ не найден" };

  if (order.status === "paid" || order.status === "refunded") {
    return { ok: true, already: true, order };
  }

  let changed = 0;
  try {
    const result = await run(
      env,
      `UPDATE orders
          SET status = 'paid',
              external_id = COALESCE(external_id, ?),
              telegram_charge_id = COALESCE(?, telegram_charge_id),
              provider_charge_id = COALESCE(?, provider_charge_id),
              paid_at = datetime('now'),
              updated_at = datetime('now')
        WHERE id = ? AND status = 'pending'`,
      event.externalId,
      event.telegramChargeId ?? null,
      event.providerChargeId ?? null,
      order.id,
    );
    changed = result.meta?.changes ?? 0;
  } catch (error) {
    // Уникальный индекс (provider, external_id): этот платёж уже привязан
    // к другому заказу. Значит, вебхук пришёл повторно с другим payload.
    await logEvent(
      env,
      "order_conflict",
      order.user_id,
      `платёж ${event.externalId}: ${error instanceof Error ? error.message : "ошибка"}`.slice(0, 300),
    );
    return { ok: false, already: true, order, error: "платёж уже привязан" };
  }

  if (!changed) {
    const fresh = await findOrder(env, publicId);
    return { ok: true, already: true, order: fresh };
  }

  return await fulfilOrder(env, order, event);
}

/** Начислить дни по оплаченному заказу. Идемпотентность — в accruals.ref. */
async function fulfilOrder(
  env: Env,
  order: OrderRow,
  event: PaidEvent,
): Promise<PaidResult> {
  const ref = `order:${order.public_id}`;
  let expiresAt: string | null = null;

  // Пакет трафика: не дни, а гигабайты. Начисление идёт отдельным счётчиком,
  // чтобы в профиле было видно, что дал тариф, а что человек докупил.
  if (isTrafficPack(order.plan_code)) {
    const gb = Number(order.plan_code.replace(/\D/g, "")) || 0;
    if (gb > 0) {
      try {
        await run(
          env,
          `UPDATE users
              SET traffic_extra_gb = COALESCE(traffic_extra_gb, 0) + ?,
                  status = CASE WHEN status = 'banned' THEN 'banned' ELSE 'active' END
            WHERE id = ?`,
          gb,
          order.user_id,
        );
      } catch (error) {
        await logEvent(
          env,
          "order_accrual_fail",
          order.user_id,
          `${order.public_id}: ${error instanceof Error ? error.message : "ошибка"}`.slice(0, 300),
        );
        return { ok: false, already: false, order, error: "начисление трафика не прошло" };
      }
    }
    await recordsPayment(env, order, event);
    await logEvent(
      env,
      "paid_traffic",
      order.user_id,
      `+${gb} ГБ · ${order.amount_rub} ₽ · ${order.provider}`,
    );
    const fresh = (await findOrder(env, order.public_id)) ?? order;
    return { ok: true, already: false, order: fresh, expiresAt: null };
  }

  try {
    const outcome = await applyAccrual(env, {
      userId: order.user_id,
      kind: "payment",
      ref,
      days: order.days,
      note: `${order.plan_title} · ${order.amount_rub} ₽ · ${order.provider}`,
    });
    expiresAt = outcome.expiresAt;
  } catch (error) {
    await logEvent(
      env,
      "order_accrual_fail",
      order.user_id,
      `${order.public_id}: ${error instanceof Error ? error.message : "ошибка"}`.slice(0, 300),
    );
    return { ok: false, already: false, order, error: "начисление не прошло" };
  }

  // Оплата снимает статус «pending» и «expired», но не снимает «banned»:
  // бан — решение владельца, деньги его не отменяют.
  try {
    await run(
      env,
      `UPDATE users
          SET status = CASE WHEN status = 'banned' THEN 'banned' ELSE 'active' END,
              device_limit = CASE
                WHEN ? IS NULL THEN device_limit
                WHEN device_limit IS NULL OR device_limit < ? THEN ?
                ELSE device_limit END
        WHERE id = ?`,
      order.device_limit,
      order.device_limit,
      order.device_limit,
      order.user_id,
    );
  } catch {
    // Лимит устройств — не повод не выдать оплаченное.
  }

  await recordsPayment(env, order, event);
  await logEvent(
    env,
    "paid",
    order.user_id,
    `${order.plan_title}: ${order.amount_rub} ₽, ${order.days} дн., ${order.provider}`,
  );

  const fresh = (await findOrder(env, order.public_id)) ?? order;
  return { ok: true, already: false, order: fresh, expiresAt };
}

/**
 * Оплата не прошла / заказ отменён.
 *
 * Не трогает уже оплаченный заказ: опоздавшее уведомление об отмене не
 * должно отбирать доступ, который человек получил.
 */
export async function closeOrder(
  env: Env,
  publicId: string,
  status: Extract<OrderStatus, "failed" | "canceled" | "expired">,
  reason = "",
): Promise<boolean> {
  const result = await run(
    env,
    `UPDATE orders SET status = ?, updated_at = datetime('now'), note = ?
      WHERE public_id = ? AND status = 'pending'`,
    status,
    reason.slice(0, 200),
    publicId,
  );
  return (result.meta?.changes ?? 0) > 0;
}

/** Просроченные заказы: pending старше TTL. Вызывается по cron. */
export async function expireOrders(env: Env): Promise<number> {
  const hours = orderTtlHours(env);
  const result = await run(
    env,
    `UPDATE orders
        SET status = 'expired', updated_at = datetime('now')
      WHERE status = 'pending'
        AND created_at < datetime('now', ?)`,
    `-${hours} hours`,
  );
  const count = result.meta?.changes ?? 0;
  if (count) await logEvent(env, "orders_expired", null, `просрочено заказов: ${count}`);
  return count;
}

/**
 * Отметить возврат и снять дни.
 *
 * Сами деньги возвращает провайдер (или владелец вручную), сюда приходит уже
 * факт. Дни снимаются, но не в минус: остаток не может стать отрицательным,
 * иначе следующий платёж «съелся» бы прошлым возвратом.
 */
export async function markOrderRefunded(
  env: Env,
  publicId: string,
  options: { deductDays?: boolean; note?: string } = {},
): Promise<{ ok: boolean; already: boolean; daysRemoved: number }> {
  const order = await findOrder(env, publicId);
  if (!order) return { ok: false, already: false, daysRemoved: 0 };
  if (order.status === "refunded") return { ok: true, already: true, daysRemoved: 0 };
  if (order.status !== "paid") {
    return { ok: false, already: false, daysRemoved: 0 };
  }

  const result = await run(
    env,
    `UPDATE orders SET status = 'refunded', refunded_at = datetime('now'),
            updated_at = datetime('now'), note = ?
      WHERE id = ? AND status = 'paid'`,
    (options.note ?? "").slice(0, 200),
    order.id,
  );
  if (!(result.meta?.changes ?? 0)) {
    return { ok: true, already: true, daysRemoved: 0 };
  }

  let removed = 0;
  if (options.deductDays !== false) {
    const user = await one<UserRow>(env, "SELECT * FROM users WHERE id = ?", order.user_id);
    if (user?.expires_at) {
      const current = Date.parse(`${user.expires_at.replace(" ", "T")}Z`);
      if (Number.isFinite(current)) {
        const next = Math.max(Date.now(), current - order.days * 86400_000);
        await run(
          env,
          "UPDATE users SET expires_at = ? WHERE id = ?",
          new Date(next).toISOString().replace("T", " ").slice(0, 19),
          user.id,
        );
        removed = order.days;
      }
    }
  }

  await logEvent(
    env,
    "refund",
    order.user_id,
    `${order.public_id}: ${order.amount_rub} ₽, снято ${removed} дн.`,
  );
  return { ok: true, already: false, daysRemoved: removed };
}

export interface Revenue {
  today: { count: number; sum: number };
  week: { count: number; sum: number };
  month: { count: number; sum: number };
  total: { count: number; sum: number };
  refunded: { count: number; sum: number };
  activeSubs: number;
  pending: number;
}

/**
 * Деньги за периоды. Считается по `paid_at`, а не по `created_at`:
 * заказ, созданный в 23:50 и оплаченный в 00:10, принадлежит новому дню.
 */
export async function revenue(env: Env): Promise<Revenue> {
  const empty: Revenue = {
    today: { count: 0, sum: 0 },
    week: { count: 0, sum: 0 },
    month: { count: 0, sum: 0 },
    total: { count: 0, sum: 0 },
    refunded: { count: 0, sum: 0 },
    activeSubs: 0,
    pending: 0,
  };

  let row:
    | {
        today_n: number;
        today_s: number;
        week_n: number;
        week_s: number;
        month_n: number;
        month_s: number;
        total_n: number;
        total_s: number;
        refund_n: number;
        refund_s: number;
      }
    | null = null;

  try {
    row = await one(
      env,
      `SELECT
         SUM(CASE WHEN status='paid' AND paid_at >= datetime('now','start of day') THEN 1 ELSE 0 END) AS today_n,
         COALESCE(SUM(CASE WHEN status='paid' AND paid_at >= datetime('now','start of day') THEN amount_rub ELSE 0 END),0) AS today_s,
         SUM(CASE WHEN status='paid' AND paid_at >= datetime('now','-7 days') THEN 1 ELSE 0 END) AS week_n,
         COALESCE(SUM(CASE WHEN status='paid' AND paid_at >= datetime('now','-7 days') THEN amount_rub ELSE 0 END),0) AS week_s,
         SUM(CASE WHEN status='paid' AND paid_at >= datetime('now','-30 days') THEN 1 ELSE 0 END) AS month_n,
         COALESCE(SUM(CASE WHEN status='paid' AND paid_at >= datetime('now','-30 days') THEN amount_rub ELSE 0 END),0) AS month_s,
         SUM(CASE WHEN status='paid' THEN 1 ELSE 0 END) AS total_n,
         COALESCE(SUM(CASE WHEN status='paid' THEN amount_rub ELSE 0 END),0) AS total_s,
         SUM(CASE WHEN status='refunded' THEN 1 ELSE 0 END) AS refund_n,
         COALESCE(SUM(CASE WHEN status='refunded' THEN amount_rub ELSE 0 END),0) AS refund_s
       FROM orders`,
    );
  } catch {
    return empty;
  }
  if (!row) return empty;

  const num = (value: unknown) => Number(value ?? 0) || 0;

  try {
    const subs = await one<{ n: number }>(
      env,
      `SELECT COUNT(*) AS n FROM users
        WHERE status = 'active' AND (expires_at IS NULL OR expires_at > datetime('now'))`,
    );
    empty.activeSubs = num(subs?.n);
  } catch {
    // без подписчиков
  }
  try {
    const pending = await one<{ n: number }>(
      env,
      "SELECT COUNT(*) AS n FROM orders WHERE status = 'pending'",
    );
    empty.pending = num(pending?.n);
  } catch {
    // без ожидающих
  }

  return {
    today: { count: num(row.today_n), sum: num(row.today_s) },
    week: { count: num(row.week_n), sum: num(row.week_s) },
    month: { count: num(row.month_n), sum: num(row.month_s) },
    total: { count: num(row.total_n), sum: num(row.total_s) },
    refunded: { count: num(row.refund_n), sum: num(row.refund_s) },
    activeSubs: empty.activeSubs,
    pending: empty.pending,
  };
}
