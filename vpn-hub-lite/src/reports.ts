/** Отчёт админу и ежедневные напоминания о сроках. */

import { many, one } from "./db";
import { escapeHtml, notifyUser, sendToAdmin } from "./bot/telegram";
import type { Env, SourceRow, UserRow } from "./types";

interface Counts {
  users_active: number;
  users_pending: number;
  users_banned: number;
  servers_alive: number;
  servers_dead: number;
  sources_alive: number;
  sources_dead: number;
}

export async function buildReport(env: Env): Promise<string> {
  const counts = await one<Counts>(
    env,
    `SELECT
      (SELECT COUNT(*) FROM users WHERE status='active')   AS users_active,
      (SELECT COUNT(*) FROM users WHERE status='pending')  AS users_pending,
      (SELECT COUNT(*) FROM users WHERE status='banned')   AS users_banned,
      (SELECT COUNT(*) FROM servers WHERE status='alive')  AS servers_alive,
      (SELECT COUNT(*) FROM servers WHERE status='dead')   AS servers_dead,
      (SELECT COUNT(*) FROM sources WHERE status='alive')  AS sources_alive,
      (SELECT COUNT(*) FROM sources WHERE status='dead')   AS sources_dead`,
  );

  const soon = await many<UserRow>(
    env,
    `SELECT * FROM users
     WHERE status='active' AND expires_at IS NOT NULL
       AND date(expires_at) <= date('now', '+3 days')
     ORDER BY expires_at
     LIMIT 10`,
  );

  const lines = [
    "<b>VPN Hub · отчёт</b>",
    `Люди: активных ${counts?.users_active ?? 0}, ждут ${counts?.users_pending ?? 0}, забанено ${counts?.users_banned ?? 0}`,
    `Серверы: живых ${counts?.servers_alive ?? 0}, мёртвых ${counts?.servers_dead ?? 0}`,
    `Источники: живых ${counts?.sources_alive ?? 0}, мёртвых ${counts?.sources_dead ?? 0}`,
  ];

  if (soon.length) {
    lines.push("", "<b>Скоро истекают:</b>");
    for (const user of soon) {
      lines.push(
        `• ${escapeHtml(labelFor(user))} — ${user.expires_at?.slice(0, 10) ?? "?"}`,
      );
    }
  } else {
    lines.push("", "Ни у кого срок не истекает в ближайшие 3 дня.");
  }

  return lines.join("\n");
}

function labelFor(user: UserRow): string {
  return user.tg_username ? `@${user.tg_username}` : `id ${user.tg_id}`;
}

interface DeadlineRow {
  id: number;
  name: string;
  days: number;
}

/**
 * Раз в сутки: напоминания за 3 дня и в день окончания — людям и по источникам.
 * Точка входа — health-cron, ночью.
 */
export async function dailyDigest(env: Env): Promise<void> {
  const users = await many<UserRow & { days_left: number }>(
    env,
    `SELECT *, CAST(julianday(date(expires_at)) - julianday(date('now')) AS INTEGER) AS days_left
     FROM users
     WHERE status='active' AND expires_at IS NOT NULL
       AND date(expires_at) IN (date('now'), date('now', '+3 days'))`,
  );

  for (const user of users) {
    const days = user.days_left;
    const tail =
      days <= 0
        ? "Сегодня последний день подписки. Напишите админу, чтобы продлить."
        : `Подписка закончится через ${days} дн. Напишите админу, чтобы продлить.`;
    await notifyUser(
      env,
      user.id,
      `<b>VPN Hub</b>\n${tail}\nСсылка не изменилась — продлевать в Happ ничего не нужно.`,
    );
  }

  const sources = await many<DeadlineRow>(
    env,
    `SELECT id, name, CAST(julianday(date(expires_at)) - julianday(date('now')) AS INTEGER) AS days
     FROM sources
     WHERE expires_at IS NOT NULL
       AND date(expires_at) IN (date('now'), date('now', '+3 days'))
       AND visibility = 'shareable'`,
  );

  if (sources.length) {
    const lines = ["<b>Источники на исходе</b>"];
    for (const source of sources) {
      lines.push(`• ${escapeHtml(source.name)}: ${source.days <= 0 ? "сегодня" : `через ${source.days} дн.`}`);
    }
    await sendToAdmin(env, lines.join("\n"));
  }

  await sendToAdmin(env, await buildReport(env));
}

/** Сколько источников исчерпали трафик — для /report. */
export async function exhaustedSources(env: Env): Promise<SourceRow[]> {
  return await many<SourceRow>(
    env,
    `SELECT * FROM sources
     WHERE traffic_total IS NOT NULL AND traffic_used IS NOT NULL
       AND traffic_used >= traffic_total`,
  );
}
