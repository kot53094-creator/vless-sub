/**
 * РђРІС‚РѕСѓРІРµРґРѕРјР»РµРЅРёСЏ: СЃСЂРѕРє РїРѕРґРїРёСЃРєРё, РІРѕР·РІСЂР°С‚ РїРѕСЃР»Рµ РёСЃС‚РµС‡РµРЅРёСЏ.
 *
 * Р–РёРІС‘С‚ РІРЅСѓС‚СЂРё РїРѕР»СѓС‡Р°СЃРѕРІРѕРіРѕ cron. Р”РµРґСѓРїР»РёРєР°С†РёСЏ вЂ” С‚Р°Р±Р»РёС†Р° notify_log СЃ РїРµСЂРІРёС‡РЅС‹Рј
 * РєР»СЋС‡РѕРј (user_id, kind, period): РѕРґРЅР° Рё С‚Р° Р¶Рµ РЅРѕРІРѕСЃС‚СЊ РЅРµ СѓС…РѕРґРёС‚ РґРІР°Р¶РґС‹,
 * РґР°Р¶Рµ РµСЃР»Рё cron РѕС‚СЂР°Р±РѕС‚Р°Р» РЅРµСЃРєРѕР»СЊРєРѕ СЂР°Р·.
 */

import { logEvent, many, run } from "./db";
import { expireSquads, flag, loadSettings, num } from "./bonus";
import { sendBanner } from "./banners";
import { expiringKeyboard } from "./bot/texts";
import { escapeHtml, sendToAdmin } from "./bot/telegram";
import { mskDate, parseTs, plural } from "./promotions";
import type { Env, UserRow } from "./types";

// Р”РµСЂР¶РёРј Р·Р°РїР°СЃ РїРѕ Р»РёРјРёС‚Сѓ Р±РµСЃРїР»Р°С‚РЅРѕРіРѕ РїР»Р°РЅР°: 50 РїРѕРґР·Р°РїСЂРѕСЃРѕРІ РЅР° РёРЅРІРѕРєР°С†РёСЋ,
// РёР· РЅРёС… С‡Р°СЃС‚СЊ СѓР¶Рµ СЃСЉРµРґР°РµС‚ РїСЂРѕРІРµСЂРєР° СЃРµСЂРІРµСЂРѕРІ РІ С‚РѕРј Р¶Рµ С‚РёРєРµ cron.
const MAX_SENDS = 8;

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
      `<b>РџРѕРґРїРёСЃРєР° Р·Р°РєРѕРЅС‡РёР»Р°СЃСЊ</b>\n` +
      `Р”РѕСЃС‚СѓРї Рє СЃРµСЂРІРµСЂР°Рј РїСЂРёРѕСЃС‚Р°РЅРѕРІР»РµРЅ.\n\n` +
      `Р—Р°Р±РµСЂРёС‚Рµ Р±РѕРЅСѓСЃ РґРЅСЏ РёР»Рё РїСЂРѕРґР»РёС‚Рµ Сѓ Р°РґРјРёРЅРёСЃС‚СЂР°С‚РѕСЂР°.`
    );
  }
  return (
    `<b>РџРѕРґРїРёСЃРєР° Р·Р°РєР°РЅС‡РёРІР°РµС‚СЃСЏ</b>\n` +
    `РћСЃС‚Р°Р»РѕСЃСЊ ${days} ${plural(days, "РґРµРЅСЊ", "РґРЅСЏ", "РґРЅРµР№")}.\n\n` +
    `РџСЂРѕРґР»РёС‚Рµ Р·Р°СЂР°РЅРµРµ, С‡С‚РѕР±С‹ VPN РЅРµ РѕС‚РєР»СЋС‡РёР»СЃСЏ.`
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
        `<b>Р’РѕР·РІСЂР°С‰Р°Р№С‚РµСЃСЊ</b>\n` +
        `РџРѕРґРїРёСЃРєР° Р·Р°РєРѕРЅС‡РёР»Р°СЃСЊ ${overdueDays} ${plural(overdueDays, "РґРµРЅСЊ", "РґРЅСЏ", "РґРЅРµР№")} РЅР°Р·Р°Рґ.\n` +
        `Р—Р°Р±РµСЂРёС‚Рµ Р±РѕРЅСѓСЃ РґРЅСЏ вЂ” Рё РґРѕСЃС‚СѓРї РІРµСЂРЅС‘С‚СЃСЏ.`;
    }

    if (!kind) continue;
    if (!(await claimLog(env, user.id, kind, period))) continue;

    const delivered = await sendBanner(env, user.tg_id, "expiring", text, expiringKeyboard());
    if (!delivered) {
      // РќРµ СЃРјРѕРіР»Рё РґРѕСЃС‚Р°РІРёС‚СЊ вЂ” СЃРЅРёРјР°РµРј РѕС‚РјРµС‚РєСѓ, РїРѕРїСЂРѕР±СѓРµРј РІ СЃР»РµРґСѓСЋС‰РёР№ СЂР°Р·.
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

  if (sent > 0) await logEvent(env, "notify", null, `РѕС‚РїСЂР°РІР»РµРЅРѕ СѓРІРµРґРѕРјР»РµРЅРёР№: ${sent}`);
  return { sent, squads };
}

/** РЈС‚СЂРµРЅРЅСЏСЏ СЃРІРѕРґРєР° Р°РґРјРёРЅСѓ: РєС‚Рѕ РЅР° РёСЃС…РѕРґРµ, СЃРєРѕР»СЊРєРѕ РЅР°С‡РёСЃР»РµРЅРёР№ Р·Р° СЃСѓС‚РєРё. */
export async function dailyDigest(env: Env): Promise<void> {
  const expiring = await many<{ tg_id: string; expires_at: string }>(
    env,
    `SELECT tg_id, expires_at FROM users
      WHERE status = 'active' AND expires_at IS NOT NULL
        AND expires_at <= datetime('now', '+3 days') ORDER BY expires_at LIMIT 20`,
  );
  const lines = expiring.map(
    (row) => `${escapeHtml(row.tg_id)} вЂ” РґРѕ ${row.expires_at.slice(0, 10)}`,
  );
  await sendToAdmin(
    env,
    `<b>РЎРІРѕРґРєР°</b>\n` +
      `Р—Р°РєР°РЅС‡РёРІР°СЋС‚СЃСЏ: ${expiring.length}\n` +
      (lines.length ? lines.join("\n") : "РЅРёРєС‚Рѕ"),
  );
}

