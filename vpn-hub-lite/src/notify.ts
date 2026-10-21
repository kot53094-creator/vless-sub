/**
 * Автоуведомления: срок подписки, возврат после истечения.
 *
 * Живёт внутри получасового cron. Дедупликация — таблица notify_log с первичным
 * ключом (user_id, kind, period): одна и та же новость не уходит дважды,
 * даже если cron отработал несколько раз.
 */

import { logEvent, many, run } from "./db";
import { expireSquads, flag, loadSettings, num } from "./bonus";
import { sendBanner } from "./banners";
import { escapeHtml, sendToAdmin } from "./bot/telegram";
import { mskDate, parseTs, plural } from "./promotions";
import type { Env, UserRow } from "./types";

// Держим запас по лимиту бесплатного плана: 50 подзапросов на инвокацию,
// из них часть уже съедает проверка серверов в том же тике cron.
const MAX_SENDS = 8;

function expiryKeyboard(): { inline_keyboard: Array<Array<{ text: string; callback_data: string }>> } {
  return {
    inline_keyboard: [
      [{ text: "👤 Кабинет", callback_data: "act:cabinet" }],
      [{ text: "🎁 Забрать бонус дня", callback_data: "bon:claim" }],
    ],
  };
}

async function claimLog(env: Env, userId: number, kind: string, period: string): Promise<boolean> {
  const result = await run(
    env,
    "INSERT OR IGNORE INTO notify_log (user_id, kind, period) VALUES (?, ?, ?)",
    userId,
    kind,
    period,
  );
  return Boolean(result.meta.changes);
}

function expiryText(user: UserRow, days: number): string {
  if (days <= 0) {
    return (
      `<b>Подписка закончилась</b>\n` +
      `Доступ к серверам приостановлен.\n\n` +
      `Заберите бонус дня или продлите у администратора.`
    );
  }
  return (
    `<b>Подписка заканчивается</b>\n` +
    `Осталось ${days} ${plural(days, "день", "дня", "дней")}.\n\n` +
    `Продлите заранее, чтобы VPN не отключился.`
  );
}

export async function runNotifications(env: Env): Promise<{ sent: number; squads: number }> {
  const settings = await loadSettings(env);
  const squads = await expireSquads(env);

  if (!flag(settings, "notify_expiring", true)) return { sent: 0, squads };

  const before = Math.max(1, num(settings, "notify_days_before", 1));
  const comebackDays = Math.max(1, num(settings, "comeback_days", 3));
  const comebackOn = flag(settings, "notify_comeback", true);
  const now = Date.now();

  const rows = await many<UserRow>(
    env,
    `SELECT * FROM users
      WHERE expires_at IS NOT NULL
        AND status IN ('active', 'expired')
        AND expires_at <= datetime('now', '+2 days')
        AND expires_at >= datetime('now', '-10 days')
      ORDER BY expires_at LIMIT 40`,
  );

  let sent = 0;
  for (const user of rows) {
    if (sent >= MAX_SENDS) break;
    const ts = parseTs(user.expires_at);
    if (ts === null) continue;
    const daysLeft = Math.ceil((ts - now) / 86400_000);

    let kind = "";
    let period = "";
    let text = "";

    if (ts >= now) {
      if (daysLeft > before) continue;
      const expiresToday = mskDate(ts) === mskDate(now);
      kind = expiresToday ? "exp_today" : `exp_${daysLeft}d`;
      period = mskDate(ts);
      text = expiryText(user, daysLeft);
    } else {
      if (!comebackOn) continue;
      const overdueDays = Math.floor((now - ts) / 86400_000);
      if (overdueDays < comebackDays || overdueDays > comebackDays + 2) continue;
      kind = "comeback";
      period = mskDate(ts);
      text =
        `<b>Возвращайтесь</b>\n` +
        `Подписка закончилась ${overdueDays} ${plural(overdueDays, "день", "дня", "дней")} назад.\n` +
        `Заберите бонус дня — и доступ вернётся.`;
    }

    if (!kind) continue;
    if (!(await claimLog(env, user.id, kind, period))) continue;

    const delivered = await sendBanner(env, user.tg_id, "expiring", text, expiryKeyboard());
    if (!delivered) {
      // Не смогли доставить — снимаем отметку, попробуем в следующий раз.
      await run(
        env,
        "DELETE FROM notify_log WHERE user_id = ? AND kind = ? AND period = ?",
        user.id,
        kind,
        period,
      );
      continue;
    }
    sent += 1;
  }

  if (sent > 0) await logEvent(env, "notify", null, `отправлено уведомлений: ${sent}`);
  return { sent, squads };
}

/** Утренняя сводка админу: кто на исходе, сколько начислений за сутки. */
export async function dailyDigest(env: Env): Promise<void> {
  const expiring = await many<{ tg_id: string; expires_at: string }>(
    env,
    `SELECT tg_id, expires_at FROM users
      WHERE status = 'active' AND expires_at IS NOT NULL
        AND expires_at <= datetime('now', '+3 days') ORDER BY expires_at LIMIT 20`,
  );
  const lines = expiring.map(
    (row) => `${escapeHtml(row.tg_id)} — до ${row.expires_at.slice(0, 10)}`,
  );
  await sendToAdmin(
    env,
    `<b>Сводка</b>\n` +
      `Заканчиваются: ${expiring.length}\n` +
      (lines.length ? lines.join("\n") : "никто"),
  );
}
