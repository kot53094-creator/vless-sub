/**
 * Витрина и касса в боте.
 *
 * Поток: /buy → список тарифов → способ оплаты → счёт → выдача.
 *
 * Тексты намеренно без обещаний «обхода блокировок»: реклама таких средств в
 * России запрещена с 1 сентября 2025 года, и формулировки в интерфейсе — это
 * тоже коммуникация сервиса. Здесь говорится о доступе, скорости и устройствах.
 */

import { escapeHtml, sendMessage, sendToAdmin, type ReplyMarkup } from "./telegram";
import { envStr } from "../security";
import type { Env, UserRow } from "../types";
import { loadPlans, type PlanRow } from "../plans";
import { findOrder, listOrders, markOrderPaid, ordersReady } from "../orders";
import { checkout, enabledProviders, notifyPaid, planPriceLine, PROVIDER_LABELS } from "../pay";
import { formatRub, formatStars, starsForPlan } from "../pay/money";
import type { PayPlan, ProviderId } from "../pay/types";

function asPlan(plan: PlanRow): PayPlan {
  return {
    code: plan.code,
    title: plan.title,
    days: plan.days,
    price_rub: plan.price_rub,
    price_stars: (plan as unknown as { price_stars?: number | null }).price_stars ?? null,
    device_limit: plan.device_limit,
    traffic_gb: plan.traffic_gb,
    note: plan.note,
  };
}

/** Тарифы, которые можно купить: 0 ₽ — это пробный, его выдаёт /start. */
export async function shopPlans(env: Env): Promise<PayPlan[]> {
  const plans = await loadPlans(env);
  return plans.filter((plan) => plan.price_rub > 0 && plan.days > 0).map(asPlan);
}

function plansKeyboard(plans: PayPlan[], env: Env): ReplyMarkup {
  const rows = plans.map((plan) => [
    {
      text: `${plan.title} · ${planPriceLine(plan, env)}`,
      callback_data: `pay:plan:${plan.code}`.slice(0, 60),
    },
  ]);
  rows.push([{ text: "🎟 У меня промокод", callback_data: "prm:enter" }]);
  return { inline_keyboard: rows };
}

export function plansScreen(plans: PayPlan[], env: Env): string {
  const lines = [
    "<b>Тарифы</b>",
    "",
    "Одна подписка на все серверы. Доступ включается сразу после оплаты, срок добавляется к текущему.",
    "",
  ];
  for (const plan of plans) {
    const bits = [`<b>${escapeHtml(plan.title)}</b>`, formatRub(plan.price_rub)];
    if (enabledProviders(env).includes("stars")) {
      bits.push(formatStars(starsForPlan(plan, env)));
    }
    lines.push(`• ${bits.join(" · ")}`);
    if (plan.device_limit) lines.push(`  <i>до ${plan.device_limit} устройств</i>`);
    else if (plan.note) lines.push(`  <i>${escapeHtml(plan.note)}</i>`);
  }
  lines.push(
    "",
    "Оплата: звёздами Telegram внутри бота; картой, СБП, переводом или криптой — на странице оплаты.",
  );
  lines.push("Возврат — в течение 3 дней, если сервис не работает: /paysupport");
  return lines.join("\n");
}

export async function sendBuyMenu(env: Env, chatId: number | string): Promise<void> {
  const plans = await shopPlans(env);
  if (!plans.length) {
    await sendMessage(
      env,
      chatId,
      "Тарифы ещё не настроены. Напишите администратору — он подключит оплату.",
    );
    return;
  }
  // Кнопка «Оплатить», которая падает, хуже её отсутствия: сообщаем честно.
  if (!(await ordersReady(env))) {
    await sendMessage(
      env,
      chatId,
      "Онлайн-оплата ещё активируется (обновляется база). Напишите администратору: /help — он продлит вручную.",
    );
    return;
  }
  await sendMessage(env, chatId, plansScreen(plans, env), plansKeyboard(plans, env));
}

/** Экран выбора способа оплаты для конкретного тарифа. */
export async function sendPlanScreen(
  env: Env,
  chatId: number | string,
  planCode: string,
): Promise<void> {
  const plans = await shopPlans(env);
  const plan = plans.find((item) => item.code === planCode) ?? plans[0];
  if (!plan) {
    await sendMessage(env, chatId, "Тариф не найден. Откройте /buy");
    return;
  }

  const providers = enabledProviders(env).filter((item) => item !== "manual");
  const rows: Array<Array<{ text: string; callback_data?: string; url?: string }>> = [];

  const viaStars = providers.includes("stars");
  const stars = starsForPlan(plan, env);
  if (viaStars) {
    rows.push([
      {
        text: `⭐ Оплатить ${stars} звёзд`,
        callback_data: `pay:stars:${plan.code}`.slice(0, 60),
      },
    ]);
  }
  if (providers.includes("cryptopay")) {
    rows.push([{ text: "🪙 USDT / TON", callback_data: `pay:crypto:${plan.code}`.slice(0, 60) }]);
  }
  if (providers.includes("yookassa")) {
    rows.push([{ text: "💳 Карта РФ", callback_data: `pay:card:${plan.code}`.slice(0, 60) }]);
  }
  if (providers.includes("sbp")) {
    rows.push([{ text: "⚡ СБП", callback_data: `pay:sbp:${plan.code}`.slice(0, 60) }]);
  }
  if (providers.includes("transfer")) {
    rows.push([
      { text: "🏦 Перевод на карту", callback_data: `pay:transfer:${plan.code}`.slice(0, 60) },
    ]);
  }
  rows.push([{ text: "← Все тарифы", callback_data: "pay:menu" }]);

  const lines = [
    `<b>${escapeHtml(plan.title)}</b> · ${formatRub(plan.price_rub)}`,
    `${plan.days} дней доступа, ${plan.device_limit ? `до ${plan.device_limit} устройств` : "без ограничения устройств"}`,
    "",
  ];
  if (!providers.length) {
    lines.push("Онлайн-оплата ещё не подключена. Напишите администратору: /help");
  } else if (viaStars) {
    lines.push(`Звёзды списывает Telegram — ${stars} ⭐. Карта и крипта — отдельными кнопками.`);
  } else {
    lines.push("Выберите способ оплаты — счёт откроется в браузере.");
  }

  await sendMessage(env, chatId, lines.join("\n"), { inline_keyboard: rows });
}

const PROVIDER_BY_PREFIX: Record<string, ProviderId> = {
  stars: "stars",
  crypto: "cryptopay",
  card: "yookassa",
  sbp: "sbp",
  transfer: "transfer",
};

/**
 * Нажатие «оплатить».
 *
 * Заказ создаётся до обращения к провайдеру: если провайдер ответит ошибкой,
 * у нас останется строка со статусом failed, а не «человек нажал, и ничего».
 */
export async function startPayment(
  env: Env,
  chatId: number | string,
  user: UserRow,
  prefix: string,
  planCode: string,
): Promise<void> {
  const provider = PROVIDER_BY_PREFIX[prefix];
  if (!provider) {
    await sendMessage(env, chatId, "Неизвестный способ оплаты.");
    return;
  }

  const plans = await shopPlans(env);
  const plan = plans.find((item) => item.code === planCode);
  if (!plan) {
    await sendMessage(env, chatId, "Тариф не найден. Откройте /buy");
    return;
  }
  if (!(await ordersReady(env))) {
    await sendMessage(env, chatId, "Оплата временно недоступна. Напишите администратору: /help");
    return;
  }

  const result = await checkout(env, user, plan, provider, provider === "stars" ? chatId : undefined);
  if (!result.ok) {
    await sendMessage(env, chatId, `Не удалось выставить счёт: ${escapeHtml(result.error ?? "")}`);
    await sendToAdmin(env, `Касса: ${provider}, тариф ${plan.code} — ошибка: ${result.error ?? ""}`);
    return;
  }

  if (result.sent) return; // счёт уже в чате

  if (result.link) {
    const order = result.order;
    await sendMessage(
      env,
      chatId,
      [
        `<b>${escapeHtml(plan.title)}</b> · ${formatRub(plan.price_rub)}`,
        `Счёт готов. Откройте страницу оплаты — доступ включится автоматически.`,
        order ? `Заказ <code>${order.public_id}</code>` : "",
      ]
        .filter(Boolean)
        .join("\n"),
      {
        inline_keyboard: [
          [{ text: `Перейти к оплате · ${PROVIDER_LABELS[provider]}`, url: result.link }],
          ...(result.order
            ? [[{ text: "✅ Я оплатил", callback_data: `pay:check:${result.order.public_id}`.slice(0, 60) }]]
            : []),
        ],
      },
    );
  }
}

/** «Я оплатил»: перечитать заказ (вебхук мог ещё не дойти). */
export async function checkPayment(
  env: Env,
  chatId: number | string,
  user: UserRow,
  publicId: string,
): Promise<void> {
  const order = await findOrder(env, publicId);
  if (!order || order.user_id !== user.id) {
    await sendMessage(env, chatId, "Заказ не найден.");
    return;
  }
  if (order.status === "paid") {
    const fresh = await findOrder(env, publicId);
    await sendMessage(
      env,
      chatId,
      `Оплата уже зачислена. ${fresh?.paid_at ? `Дата: ${fresh.paid_at.slice(0, 16)}` : ""}\nОткройте /start — ссылка в кабинете.`,
    );
    return;
  }
  if (order.status !== "pending") {
    await sendMessage(env, chatId, `Заказ в состоянии «${order.status}». Создайте новый: /buy`);
    return;
  }
  await sendMessage(
    env,
    chatId,
    "Оплата ещё не подтверждена. Обычно это занимает до минуты — проверьте позже или напишите /paysupport.",
  );
}

export async function sendMyOrders(
  env: Env,
  chatId: number | string,
  user: UserRow,
): Promise<void> {
  const orders = await listOrders(env, user.id, 10);
  if (!orders.length) {
    await sendMessage(env, chatId, "Покупок пока нет. Тарифы — /buy");
    return;
  }
  const lines = ["<b>Мои покупки</b>", ""];
  for (const order of orders) {
    const when = (order.paid_at ?? order.created_at).slice(0, 10);
    const status =
      order.status === "paid"
        ? "оплачен"
        : order.status === "pending"
          ? "ждёт оплаты"
          : order.status === "refunded"
            ? "возврат"
            : order.status;
    lines.push(
      `${when} · ${escapeHtml(order.plan_title)} · ${formatRub(order.amount_rub)} · ${status}`,
    );
    lines.push(`  <code>${order.public_id}</code>`);
  }
  lines.push("", "Проблема с оплатой — /paysupport");
  await sendMessage(env, chatId, lines.join("\n"));
}

/**
 * Текст поддержки по платежам.
 *
 * `/paysupport` — обязательная команда по условиям Telegram для ботов,
 * которые принимают Stars. Без неё бота могут отключить от платежей.
 */
export function paySupportText(env: Env): string {
  const email = envStr(env.LEGAL_EMAIL);
  const tg = envStr(env.LEGAL_TG);
  const lines = [
    "<b>Поддержка по оплате</b>",
    "",
    "Что мы можем сделать:",
    "• не пришли дни после оплаты — проверим и включим вручную;",
    "• оплатили дважды — вернём лишний платёж;",
    "• сервис не работает — вернём деньги в течение 3 дней после покупки.",
    "",
    "Напишите номер заказа (он есть в /orders) и способ оплаты.",
    "Оплатили переводом — отправьте /paid ord_xxxx, включим после проверки.",
  ];
  if (tg) lines.push(`Telegram: @${tg.replace(/^@/, "")}`);
  if (email) lines.push(`Почта: ${email}`);
  lines.push("", "Ответ обычно в течение дня.");
  return lines.join("\n");
}

/* ── события Telegram ──────────────────────────────────────────────────── */

export interface PreCheckoutQuery {
  id: string;
  from: { id: number };
  currency: string;
  total_amount: number;
  invoice_payload: string;
}

/** Проверка перед списанием: сумма и валюта должны совпасть с заказом. */
export async function preCheckoutPayloadError(
  env: Env,
  query: PreCheckoutQuery,
): Promise<string | null> {
  const order = await findOrder(env, query.invoice_payload);
  if (!order) return "Заказ не найден. Откройте /buy и создайте новый.";
  if (order.status === "paid") return "Этот счёт уже оплачен.";
  if (order.status !== "pending") return "Счёт больше не действует. Создайте новый: /buy";
  if (query.currency !== order.currency) return "Валюта счёта не совпадает.";
  if (Math.round(query.total_amount) !== Math.round(order.amount_minor)) {
    return "Сумма счёта изменилась. Создайте новый: /buy";
  }
  return null;
}

export interface SuccessfulPayment {
  currency: string;
  total_amount: number;
  invoice_payload: string;
  telegram_payment_charge_id: string;
  provider_payment_charge_id?: string;
}

/** Подтверждённая оплата звёздами — единственный повод выдать дни. */
export async function handleSuccessfulPayment(
  env: Env,
  tgId: string,
  payment: SuccessfulPayment,
): Promise<void> {
  const order = await findOrder(env, payment.invoice_payload);
  if (!order) {
    await sendToAdmin(env, `Оплата Stars без заказа: ${payment.invoice_payload.slice(0, 40)}`);
    return;
  }
  if (payment.currency !== "XTR") {
    await sendToAdmin(env, `Оплата в валюте ${payment.currency}, заказ ${order.public_id}`);
  }

  const result = await markOrderPaid(env, order.public_id, {
    externalId: payment.telegram_payment_charge_id,
    currency: payment.currency,
    amountMinor: Math.round(payment.total_amount),
    telegramChargeId: payment.telegram_payment_charge_id,
    providerChargeId: payment.provider_payment_charge_id,
    orderPublicId: order.public_id,
  });

  await notifyPaid(env, result, tgId);
}
