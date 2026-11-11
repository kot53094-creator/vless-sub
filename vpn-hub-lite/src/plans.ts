/**
 * Тарифы и ручной журнал платежей.
 *
 * Платёжный провайдер намеренно не подключён: платные сервисы не подключаются
 * без явного подтверждения владельца. Строку в payments создаёт админ
 * командой /pay уже после фактической оплаты. Схема (method, status,
 * external_id) готова к появлению онлайн-провайдера без миграции данных.
 *
 * Здесь нет ни одного обращения к внешним сервисам: только D1/Turso и
 * инвалидация KV-кэша подписки.
 */

import { logEvent, many, one, run } from "./db";
import { invalidateSubscription } from "./sub";
import type { Env, UserRow } from "./types";

export interface PlanRow {
  id: number;
  code: string;
  title: string;
  days: number;
  price_rub: number;
  device_limit: number | null;
  traffic_gb: number | null;
  active: number;
  sort: number;
  note: string;
}

export interface PayInput {
  tgId: string;
  amountRub: number;
  /** Дней доступа; если не задано — берётся из тарифа. */
  days?: number;
  planCode?: string;
  note?: string;
  actor?: string;
}

function esc(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

/** 0 ₽ — это не «бесплатно», а «цену назначает владелец». */
export function planPrice(priceRub: number): string {
  return priceRub > 0 ? `${priceRub} ₽` : "цена по договорённости";
}

export function formatPlans(plans: PlanRow[]): string {
  if (!plans.length) {
    return [
      "<b>Тарифы</b>",
      "Список тарифов ещё не заполнен. Напишите администратору — он подберёт срок и условия.",
    ].join("\n");
  }

  const lines = ["<b>Тарифы</b>"];
  for (const plan of plans) {
    const bits = [`${plan.days} дн.`, planPrice(plan.price_rub)];
    if (plan.device_limit) bits.push(`устройств: ${plan.device_limit}`);
    if (plan.traffic_gb) bits.push(`${plan.traffic_gb} ГБ`);
    lines.push(`• <b>${esc(plan.title)}</b> — ${bits.join(" · ")}`);
    if (plan.note) lines.push(`  <i>${esc(plan.note)}</i>`);
  }
  lines.push(
    "",
    "Оплата вручную: напишите администратору. После подтверждения доступ продлится автоматически.",
  );
  return lines.join("\n");
}

/** Тарифы из базы; пустой список, если миграция ещё не применена. */
export async function loadPlans(env: Env): Promise<PlanRow[]> {
  try {
    return await many<PlanRow>(
      env,
      `SELECT id, code, title, days, price_rub, device_limit, traffic_gb, active, sort, note
         FROM plans WHERE active = 1 ORDER BY sort, id`,
    );
  } catch {
    return [];
  }
}

export async function plansText(env: Env): Promise<string> {
  return formatPlans(await loadPlans(env));
}

/**
 * Записать оплату и (если указаны дни) продлить доступ.
 *
 * Не путать с recordPayment из src/payments.ts: тот пишет безденежный след
 * каждой выдачи (kind/days), а этот — сумму и способ оплаты.
 *
 * Идемпотентности по external_id здесь нет намеренно: ручной платёж админ
 * вводит один раз. Когда появится провайдер, его вебхук будет писать
 * external_id и проверять уникальность до вставки.
 */
export async function recordMoneyPayment(
  env: Env,
  input: PayInput,
): Promise<{ ok: boolean; message: string }> {
  const tgId = input.tgId.trim();
  if (!tgId) return { ok: false, message: "Формат: /pay &lt;tg_id&gt; &lt;сумма&gt; [дней] [заметка]" };
  if (!Number.isFinite(input.amountRub) || input.amountRub < 0) {
    return { ok: false, message: "Сумма должна быть числом ≥ 0." };
  }

  const user = await one<UserRow>(env, "SELECT * FROM users WHERE tg_id = ?", tgId);
  if (!user) return { ok: false, message: `Не нашёл пользователя ${tgId}.` };

  let days = input.days ?? 0;
  let plan: PlanRow | null = null;
  if (input.planCode) {
    plan = await one<PlanRow>(env, "SELECT * FROM plans WHERE code = ?", input.planCode);
    if (!plan) return { ok: false, message: `Нет тарифа ${input.planCode}.` };
    if (!input.days) days = plan.days;
  }
  if (!Number.isFinite(days) || days < 0) {
    return { ok: false, message: "Дней должно быть числом ≥ 0." };
  }

  await run(
    env,
    `INSERT INTO payments (user_id, plan_code, amount_rub, days, method, status, note, actor, paid_at)
     VALUES (?, ?, ?, ?, 'manual', 'paid', ?, ?, datetime('now'))`,
    user.id,
    plan?.code ?? null,
    Math.round(input.amountRub),
    days,
    (input.note ?? "").slice(0, 200),
    (input.actor ?? "").slice(0, 80),
  );

  let until = user.expires_at;
  if (days > 0) {
    // Срок продлевается от максимума «сейчас» и текущей даты окончания:
    // просроченная подписка не «съедает» оплаченные дни.
    const base = user.expires_at
      ? new Date(user.expires_at.replace(" ", "T") + "Z")
      : new Date();
    const from = Math.max(base.getTime(), Date.now());
    until = new Date(from + days * 86400_000).toISOString().slice(0, 19).replace("T", " ");
    await run(
      env,
      "UPDATE users SET status='active', expires_at=? WHERE id=?",
      until,
      user.id,
    );
    await invalidateSubscription(env, user.sub_token);
  }

  await logEvent(
    env,
    "payment",
    user.id,
    `${Math.round(input.amountRub)} ₽, ${days} дн.${plan ? `, ${plan.code}` : ""}`,
  );

  const parts = [`Платёж записан: ${Math.round(input.amountRub)} ₽`];
  if (days > 0) {
    parts.push(`доступ продлён на ${days} дн. до ${until?.slice(0, 10) ?? "—"}`);
  } else {
    parts.push("срок не менялся");
  }
  return { ok: true, message: parts.join(", ") + "." };
}

/** Последние платежи — для админской команды /payments. */
export async function paymentsText(env: Env, limit = 10): Promise<string> {
  const safeLimit = Math.min(Math.max(Math.trunc(limit) || 10, 1), 50);
  let rows: Array<{
    id: number;
    tg_id: string;
    amount_rub: number;
    days: number;
    status: string;
    created_at: string;
  }>;
  try {
    rows = await many(
      env,
      `SELECT p.id, u.tg_id, p.amount_rub, p.days, p.status, p.created_at
         FROM payments p JOIN users u ON u.id = p.user_id
        ORDER BY p.id DESC LIMIT ?`,
      safeLimit,
    );
  } catch {
    return "Журнал платежей ещё не создан: примените миграцию 0020.";
  }

  if (!rows.length) return "Платежей пока нет.";

  const total = rows.reduce((sum, row) => sum + Number(row.amount_rub), 0);
  return [
    `<b>Последние платежи</b> (${rows.length})`,
    ...rows.map(
      (row) =>
        `• ${row.created_at.slice(0, 10)} · ${esc(row.tg_id)} · ${row.amount_rub} ₽ · ${row.days} дн. · ${row.status}`,
    ),
    `Итого по списку: ${total} ₽`,
  ].join("\n");
}
