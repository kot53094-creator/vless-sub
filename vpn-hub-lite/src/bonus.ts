/**
 * Начисления: бонус дня, канал, рефералы, промокоды, группы.
 *
 * Главное правило: любое начисление проходит через applyAccrual с уникальным
 * ref. Повторный вызов возвращает duplicate=true и ничего не меняет —
 * идемпотентность держится на UNIQUE(accruals.ref), а не на логике в коде.
 */

import { logEvent, many, one, run } from "./db";
import { invalidateSubscription } from "./sub";
import { envStr } from "./security";
import { pushToRemnawave, remnawaveEnabled } from "./remnawave";
import type { Env, UserRow } from "./types";
import {
  clampToCap,
  extendExpiry,
  mskDate,
  mskMonth,
  nextStreak,
  normalizePromo,
  parseTs,
  refCode,
  round2,
  shiftDate,
  streakHours,
} from "./promotions";

export type AccrualKind = "daily" | "channel" | "referral" | "promo" | "clicker" | "manual";

export interface AccrualInput {
  userId: number;
  kind: AccrualKind;
  ref: string;
  days?: number;
  hours?: number;
  gb?: number;
  squad?: string;
  squadDays?: number;
  note?: string;
}

export interface AccrualOutcome {
  ok: boolean;
  duplicate: boolean;
  hours: number;
  expiresAt: string | null;
}

/* ── настройки ─────────────────────────────────────────────────────────── */

const DEFAULTS: Record<string, string> = {
  daily_enabled: "1",
  daily_bonus_hours: "1",
  daily_streak3_hours: "2",
  daily_streak7_hours: "3",
  daily_month_cap_hours: "48",
  channel_reward_days: "1",
  referral_enabled: "1",
  referral_reward_days: "1",
  referral_month_cap_days: "30",
  promo_enabled: "1",
  squads_enabled: "0",
  notify_expiring: "1",
  notify_days_before: "1",
  notify_comeback: "1",
  comeback_days: "3",
  clicker_enabled: "0",
  clicker_daily_cap_hours: "3",
};

export type Settings = Record<string, string>;

export async function loadSettings(env: Env): Promise<Settings> {
  const rows = await many<{ key: string; value: string }>(
    env,
    "SELECT key, value FROM settings",
  );
  const map: Settings = { ...DEFAULTS };
  for (const row of rows) map[row.key] = row.value;
  return map;
}

export function num(settings: Settings, key: string, fallback: number): number {
  const value = Number(settings[key]);
  return Number.isFinite(value) ? value : fallback;
}

export function flag(settings: Settings, key: string, fallback = false): boolean {
  const value = settings[key];
  if (value === undefined) return fallback;
  return value === "1" || value === "true";
}

export async function saveSetting(env: Env, key: string, value: string): Promise<void> {
  await run(
    env,
    `INSERT INTO settings (key, value, updated_at) VALUES (?, ?, datetime('now'))
     ON CONFLICT (key) DO UPDATE SET value = excluded.value, updated_at = datetime('now')`,
    key,
    value,
  );
}

/* ── ядро: начисление ──────────────────────────────────────────────────── */

export async function applyAccrual(env: Env, input: AccrualInput): Promise<AccrualOutcome> {
  const hours = round2((input.hours ?? 0) + (input.days ?? 0) * 24);
  const gb = Math.round(input.gb ?? 0);

  const inserted = await run(
    env,
    `INSERT OR IGNORE INTO accruals (user_id, kind, ref, days, hours, gb, squad, note)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    input.userId,
    input.kind,
    input.ref,
    input.days ?? 0,
    hours,
    gb,
    input.squad ?? null,
    (input.note ?? "").slice(0, 200),
  );

  if (!inserted.meta.changes) {
    const user = await one<UserRow>(env, "SELECT * FROM users WHERE id = ?", input.userId);
    return { ok: true, duplicate: true, hours: 0, expiresAt: user?.expires_at ?? null };
  }

  const user = await one<UserRow>(env, "SELECT * FROM users WHERE id = ?", input.userId);
  if (!user) {
    await run(env, "DELETE FROM accruals WHERE ref = ?", input.ref);
    return { ok: false, duplicate: false, hours: 0, expiresAt: null };
  }

  if (hours > 0) {
    const expiresAt = extendExpiry(user.expires_at, hours);
    await run(env, "UPDATE users SET expires_at = ? WHERE id = ?", expiresAt, user.id);
    // Бонус возвращает доступ только тем, у кого он был. Заявки (pending)
    // бонусом не активируются — это решает админ.
    if (user.status === "expired") {
      await run(env, "UPDATE users SET status = 'active' WHERE id = ?", user.id);
    }
  }
  if (gb > 0) {
    await run(env, "UPDATE users SET traffic_gb = traffic_gb + ? WHERE id = ?", gb, user.id);
  }
  if (input.squad) {
    await grantSquad(env, user.id, input.squad, input.squadDays ?? 0);
  }

  await invalidateSubscription(env, user.sub_token);
  await logEvent(
    env,
    "accrual",
    user.id,
    `${input.kind}: +${hours} ч, +${gb} ГБ${input.note ? ` (${input.note})` : ""}`,
  );

  if (remnawaveEnabled(env)) {
    await pushToRemnawave(env, user, hours, gb);
  }

  const fresh = await one<{ expires_at: string | null }>(
    env,
    "SELECT expires_at FROM users WHERE id = ?",
    user.id,
  );
  return { ok: true, duplicate: false, hours, expiresAt: fresh?.expires_at ?? null };
}

/* ── ежедневный бонус ──────────────────────────────────────────────────── */

export interface DailyStatus {
  claimedToday: boolean;
  streak: number;
  usedHours: number;
  capHours: number;
  hoursLeft: number;
  nextAt: number;
  enabled: boolean;
}

export async function bonusHoursThisMonth(env: Env, userId: number): Promise<number> {
  const month = mskMonth();
  const rows = await many<{ hours: number; created_at: string }>(
    env,
    `SELECT hours, created_at FROM accruals
      WHERE user_id = ? AND status = 'applied' AND kind IN ('daily', 'clicker')
        AND created_at >= datetime('now', '-40 days')`,
    userId,
  );
  return round2(
    rows
      .filter((row) => mskMonth(parseTs(row.created_at) ?? 0) === month)
      .reduce((sum, row) => sum + Number(row.hours ?? 0), 0),
  );
}

/** Ближайшая полночь по Москве в миллисекундах. */
export function nextMskMidnight(now: number = Date.now()): number {
  const tomorrow = shiftDate(mskDate(now), 1);
  return Date.parse(`${tomorrow}T00:00:00+03:00`);
}

export async function dailyStatus(env: Env, user: UserRow): Promise<DailyStatus> {
  const settings = await loadSettings(env);
  const today = mskDate();
  const claim = await one<{ streak: number }>(
    env,
    "SELECT streak FROM daily_claims WHERE user_id = ? AND claim_date = ?",
    user.id,
    today,
  );
  const last = await one<{ claim_date: string; streak: number }>(
    env,
    "SELECT claim_date, streak FROM daily_claims WHERE user_id = ? ORDER BY claim_date DESC LIMIT 1",
    user.id,
  );
  const streak = claim?.streak ?? nextStreak(last?.claim_date ?? null, last?.streak ?? 0, today);
  const cap = num(settings, "daily_month_cap_hours", 48);
  const used = await bonusHoursThisMonth(env, user.id);
  return {
    claimedToday: Boolean(claim),
    streak,
    usedHours: used,
    capHours: cap,
    hoursLeft: Math.max(0, round2(cap - used)),
    nextAt: nextMskMidnight(),
    enabled: flag(settings, "daily_enabled", true),
  };
}

export type DailyResult =
  | { ok: true; hours: number; streak: number; expiresAt: string | null }
  | {
      ok: false;
      reason: "disabled" | "already" | "month_cap" | "failed" | "inactive";
      status: DailyStatus;
    };

export async function claimDaily(env: Env, user: UserRow): Promise<DailyResult> {
  const status = await dailyStatus(env, user);
  if (user.status !== "active") return { ok: false, reason: "inactive", status };
  if (!status.enabled) return { ok: false, reason: "disabled", status };
  if (status.claimedToday) return { ok: false, reason: "already", status };

  const settings = await loadSettings(env);
  const today = mskDate();
  const last = await one<{ claim_date: string; streak: number }>(
    env,
    "SELECT claim_date, streak FROM daily_claims WHERE user_id = ? ORDER BY claim_date DESC LIMIT 1",
    user.id,
  );
  const streak = nextStreak(last?.claim_date ?? null, last?.streak ?? 0, today);
  const want = streakHours(
    streak,
    num(settings, "daily_bonus_hours", 1),
    num(settings, "daily_streak3_hours", 2),
    num(settings, "daily_streak7_hours", 3),
  );
  const cap = num(settings, "daily_month_cap_hours", 48);
  const used = await bonusHoursThisMonth(env, user.id);
  const hours = clampToCap(used, cap, want);
  if (hours <= 0) return { ok: false, reason: "month_cap", status };

  // Именно INSERT OR IGNORE: два одновременных тапа дадут одну строку.
  const claim = await run(
    env,
    "INSERT OR IGNORE INTO daily_claims (user_id, claim_date, streak, hours) VALUES (?, ?, ?, ?)",
    user.id,
    today,
    streak,
    hours,
  );
  if (!claim.meta.changes) return { ok: false, reason: "already", status };

  const outcome = await applyAccrual(env, {
    userId: user.id,
    kind: "daily",
    ref: `daily:${user.id}:${today}`,
    hours,
    note: `серия ${streak}`,
  });
  if (!outcome.ok) {
    await run(env, "DELETE FROM daily_claims WHERE user_id = ? AND claim_date = ?", user.id, today);
    return { ok: false, reason: "failed", status };
  }
  return { ok: true, hours, streak, expiresAt: outcome.expiresAt };
}

/* ── награда за канал ──────────────────────────────────────────────────── */

export function channelId(env: Env): string {
  return envStr(env.CHANNEL_ID);
}

export async function claimChannel(
  env: Env,
  user: UserRow,
): Promise<{ ok: boolean; reason?: "no_channel" | "not_member" | "already" | "failed"; expiresAt?: string | null }> {
  const channel = channelId(env);
  if (!channel) return { ok: false, reason: "no_channel" };

  const info = await getChatMember(env, channel, Number(user.tg_id));
  const status = info?.status ?? "";
  if (!["creator", "administrator", "member"].includes(status)) {
    return { ok: false, reason: "not_member" };
  }

  const settings = await loadSettings(env);
  const outcome = await applyAccrual(env, {
    userId: user.id,
    kind: "channel",
    ref: `channel:${user.id}`,
    days: num(settings, "channel_reward_days", 1),
    note: "подписка на канал",
  });
  if (!outcome.ok) return { ok: false, reason: "failed" };
  if (outcome.duplicate) return { ok: false, reason: "already" };
  return { ok: true, expiresAt: outcome.expiresAt };
}

async function getChatMember(
  env: Env,
  chatId: string,
  userId: number,
): Promise<{ status: string } | null> {
  const { tgRaw } = await import("./bot/telegram");
  const raw = await tgRaw<{ status?: string }>(env, "getChatMember", {
    chat_id: chatId,
    user_id: userId,
  });
  return raw.ok ? { status: raw.result?.status ?? "" } : null;
}

/* ── рефералы ──────────────────────────────────────────────────────────── */

/** Username бота: из env, из кэша или через getMe (один раз в сутки). */
async function botUsername(env: Env): Promise<string> {
  const configured = envStr(env.BOT_USERNAME).replace(/^@/, "");
  if (configured) return configured;

  const cached = await env.CACHE.get("bot:username");
  if (cached) return cached;

  const { tgRaw } = await import("./bot/telegram");
  const me = await tgRaw<{ username?: string }>(env, "getMe");
  const name = me.result?.username ?? "";
  if (name) await env.CACHE.put("bot:username", name, { expirationTtl: 86400 });
  return name;
}

export async function referralLink(env: Env, userId: number): Promise<string> {
  const bot = (await botUsername(env)) || "your_bot";
  return `https://t.me/${bot}?start=ref_${refCode(userId)}`;
}

export async function attachReferral(
  env: Env,
  invitedId: number,
  payload: string,
): Promise<boolean> {
  const match = payload.trim().match(/^ref_([0-9a-z]{1,10})$/i);
  if (!match) return false;
  const { parseRefCode } = await import("./promotions");
  const inviterId = parseRefCode(match[1] ?? "");
  if (!inviterId || inviterId === invitedId) return false;

  const inviter = await one<{ id: number }>(env, "SELECT id FROM users WHERE id = ?", inviterId);
  if (!inviter) return false;

  const result = await run(
    env,
    "INSERT OR IGNORE INTO referrals (invited_id, inviter_id, code) VALUES (?, ?, ?)",
    invitedId,
    inviterId,
    (match[1] ?? "").toLowerCase(),
  );
  if (result.meta.changes) {
    await logEvent(env, "referral_new", invitedId, `пригласил #${inviterId}`);
  }
  return Boolean(result.meta.changes);
}

async function referralDaysThisMonth(env: Env, userId: number): Promise<number> {
  const month = mskMonth();
  const rows = await many<{ days: number; hours: number; created_at: string }>(
    env,
    `SELECT days, hours, created_at FROM accruals
      WHERE user_id = ? AND status = 'applied' AND ref LIKE 'ref:i:%'
        AND created_at >= datetime('now', '-40 days')`,
    userId,
  );
  return round2(
    rows
      .filter((row) => mskMonth(parseTs(row.created_at) ?? 0) === month)
      .reduce((sum, row) => sum + Number(row.hours ?? 0) / 24, 0),
  );
}

/** Вызывается, когда приглашённый стал активным. Начисляет обоим один раз. */
export async function rewardReferral(env: Env, invitedId: number): Promise<boolean> {
  const row = await one<{ inviter_id: number }>(
    env,
    "SELECT inviter_id FROM referrals WHERE invited_id = ? AND status = 'pending'",
    invitedId,
  );
  if (!row) return false;

  const settings = await loadSettings(env);
  if (!flag(settings, "referral_enabled", true)) return false;

  const claim = await run(
    env,
    `UPDATE referrals SET status = 'rewarded', rewarded_at = datetime('now')
      WHERE invited_id = ? AND status = 'pending'`,
    invitedId,
  );
  if (!claim.meta.changes) return false;

  const days = num(settings, "referral_reward_days", 1);
  const cap = num(settings, "referral_month_cap_days", 30);
  const used = await referralDaysThisMonth(env, row.inviter_id);

  if (round2(used + days) <= cap) {
    await applyAccrual(env, {
      userId: row.inviter_id,
      kind: "referral",
      ref: `ref:i:${invitedId}`,
      days,
      note: "за приглашённого друга",
    });
  } else {
    await run(env, "UPDATE referrals SET status = 'capped' WHERE invited_id = ?", invitedId);
  }

  if (flag(settings, "referral_reward_inviter", true)) {
    await applyAccrual(env, {
      userId: invitedId,
      kind: "referral",
      ref: `ref:n:${invitedId}`,
      days,
      note: "за приглашение",
    });
  }
  return true;
}

export interface ReferralStats {
  invited: number;
  rewarded: number;
  days: number;
  link: string;
  code: string;
}

export async function referralStats(env: Env, userId: number): Promise<ReferralStats> {
  const total = await one<{ n: number }>(
    env,
    "SELECT COUNT(*) AS n FROM referrals WHERE inviter_id = ?",
    userId,
  );
  const rewarded = await one<{ n: number }>(
    env,
    "SELECT COUNT(*) AS n FROM referrals WHERE inviter_id = ? AND status = 'rewarded'",
    userId,
  );
  const days = await one<{ h: number }>(
    env,
    `SELECT COALESCE(SUM(hours), 0) AS h FROM accruals
      WHERE user_id = ? AND status = 'applied' AND ref LIKE 'ref:i:%'`,
    userId,
  );
  return {
    invited: total?.n ?? 0,
    rewarded: rewarded?.n ?? 0,
    days: round2((days?.h ?? 0) / 24),
    link: await referralLink(env, userId),
    code: refCode(userId),
  };
}

/* ── промокоды ─────────────────────────────────────────────────────────── */

export type PromoFail = "empty" | "not_found" | "expired" | "limit" | "used" | "disabled";

export interface PromoResult {
  ok: boolean;
  reason?: PromoFail;
  days?: number;
  hours?: number;
  gb?: number;
  squad?: string | null;
}

interface PromoRow {
  code: string;
  days: number;
  hours: number;
  gb: number;
  squad: string | null;
  squad_days: number;
  max_uses: number;
  used: number;
  per_user_limit: number;
  expires_at: string | null;
  active: number;
}

export async function redeemPromo(
  env: Env,
  user: UserRow,
  rawCode: string,
): Promise<PromoResult> {
  const code = normalizePromo(rawCode);
  if (!code) return { ok: false, reason: "empty" };

  const settings = await loadSettings(env);
  if (!flag(settings, "promo_enabled", true)) return { ok: false, reason: "disabled" };

  const promo = await one<PromoRow>(env, "SELECT * FROM promos WHERE code = ?", code);
  if (!promo || !promo.active) return { ok: false, reason: "not_found" };

  const expires = parseTs(promo.expires_at ? promo.expires_at.slice(0, 19) : null);
  if (expires !== null && expires < Date.now()) return { ok: false, reason: "expired" };

  const mine = await one<{ n: number }>(
    env,
    "SELECT COUNT(*) AS n FROM promo_uses WHERE code = ? AND user_id = ?",
    code,
    user.id,
  );
  if ((mine?.n ?? 0) >= Math.max(1, promo.per_user_limit)) return { ok: false, reason: "used" };

  // Занимаем активацию: уникальный индекс не даст активировать дважды.
  const claim = await run(
    env,
    "INSERT OR IGNORE INTO promo_uses (code, user_id) VALUES (?, ?)",
    code,
    user.id,
  );
  if (!claim.meta.changes) return { ok: false, reason: "used" };

  // Общий лимит: условный UPDATE — атомарная проверка под нагрузкой.
  const bump =
    promo.max_uses > 0
      ? await run(
          env,
          "UPDATE promos SET used = used + 1 WHERE code = ? AND used < max_uses",
          code,
        )
      : await run(env, "UPDATE promos SET used = used + 1 WHERE code = ?", code);

  if (!bump.meta.changes) {
    await run(env, "DELETE FROM promo_uses WHERE code = ? AND user_id = ?", code, user.id);
    return { ok: false, reason: "limit" };
  }

  const outcome = await applyAccrual(env, {
    userId: user.id,
    kind: "promo",
    ref: `promo:${code}:${user.id}`,
    days: promo.days,
    hours: promo.hours,
    gb: promo.gb,
    squad: promo.squad ?? undefined,
    squadDays: promo.squad_days,
    note: `промокод ${code}`,
  });

  if (!outcome.ok || outcome.duplicate) {
    await run(env, "DELETE FROM promo_uses WHERE code = ? AND user_id = ?", code, user.id);
    await run(env, "UPDATE promos SET used = MAX(0, used - 1) WHERE code = ?", code);
    return { ok: false, reason: "used" };
  }

  await logEvent(env, "promo", user.id, `активирован ${code}`);
  return {
    ok: true,
    days: promo.days,
    hours: promo.hours,
    gb: promo.gb,
    squad: promo.squad,
  };
}

/* ── отмена начисления ─────────────────────────────────────────────────── */

export async function cancelAccrual(env: Env, accrualId: number): Promise<boolean> {
  const row = await one<{
    id: number;
    user_id: number;
    hours: number;
    gb: number;
    status: string;
  }>(env, "SELECT id, user_id, hours, gb, status FROM accruals WHERE id = ?", accrualId);
  if (!row || row.status !== "applied") return false;

  const claim = await run(
    env,
    "UPDATE accruals SET status = 'cancelled', cancelled_at = datetime('now') WHERE id = ? AND status = 'applied'",
    accrualId,
  );
  if (!claim.meta.changes) return false;

  const user = await one<UserRow>(env, "SELECT * FROM users WHERE id = ?", row.user_id);
  if (user) {
    if (row.hours > 0 && user.expires_at) {
      const ts = parseTs(user.expires_at);
      if (ts) {
        const next = new Date(ts - row.hours * 3600_000).toISOString().replace("T", " ").slice(0, 19);
        await run(env, "UPDATE users SET expires_at = ? WHERE id = ?", next, user.id);
      }
    }
    if (row.gb > 0) {
      await run(
        env,
        "UPDATE users SET traffic_gb = MAX(0, traffic_gb - ?) WHERE id = ?",
        Math.round(row.gb),
        user.id,
      );
    }
    await invalidateSubscription(env, user.sub_token);
    await logEvent(env, "accrual_cancel", user.id, `отменено начисление #${accrualId}`);
  }
  return true;
}

/* ── группы серверов ───────────────────────────────────────────────────── */

export const SQUADS = ["Default", "Bypass"] as const;

export async function grantSquad(
  env: Env,
  userId: number,
  squad: string,
  days = 0,
): Promise<void> {
  const expiresAt = days > 0
    ? new Date(Date.now() + days * 86400_000).toISOString().replace("T", " ").slice(0, 19)
    : null;
  await run(
    env,
    `INSERT INTO user_squads (user_id, squad, expires_at) VALUES (?, ?, ?)
     ON CONFLICT (user_id, squad) DO UPDATE SET expires_at = excluded.expires_at`,
    userId,
    squad,
    expiresAt,
  );

  // Какая группа серверов соответствует squad: настраивается в админке
  // (settings.squad_pool:<squad>), иначе ищем пул с тем же названием.
  const settings = await loadSettings(env);
  const poolName = settings[`squad_pool:${squad}`] || squad;
  const pool = await one<{ id: number }>(env, "SELECT id FROM pools WHERE name = ?", poolName);
  if (pool) {
    await run(
      env,
      "INSERT OR IGNORE INTO user_pools (user_id, pool_id) VALUES (?, ?)",
      userId,
      pool.id,
    );
    // Пересоберём назначения: у пула свои серверы.
    await run(env, "DELETE FROM assignments WHERE user_id = ?", userId);
  }
}

export async function revokeSquad(env: Env, userId: number, squad: string): Promise<void> {
  const settings = await loadSettings(env);
  const poolName = settings[`squad_pool:${squad}`] || squad;
  await run(env, "DELETE FROM user_squads WHERE user_id = ? AND squad = ?", userId, squad);
  await run(
    env,
    `DELETE FROM user_pools WHERE user_id = ?
       AND pool_id IN (SELECT id FROM pools WHERE name = ?)`,
    userId,
    poolName,
  );
  await run(env, "DELETE FROM assignments WHERE user_id = ?", userId);
}

export async function squadsOf(env: Env, userId: number): Promise<Array<{ squad: string; expires_at: string | null }>> {
  return await many<{ squad: string; expires_at: string | null }>(
    env,
    "SELECT squad, expires_at FROM user_squads WHERE user_id = ? ORDER BY squad",
    userId,
  );
}

/** Снимает истёкшие группы — вызывается из cron вместе с уведомлениями. */
export async function expireSquads(env: Env): Promise<number> {
  const rows = await many<{ user_id: number; squad: string }>(
    env,
    `SELECT user_id, squad FROM user_squads
      WHERE expires_at IS NOT NULL AND expires_at < datetime('now') LIMIT 5`,
  );
  for (const row of rows) {
    await revokeSquad(env, row.user_id, row.squad);
    await logEvent(env, "squad_expired", row.user_id, row.squad);
  }
  return rows.length;
}
