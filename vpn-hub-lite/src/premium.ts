/**
 * «Платный» вид подписки: заголовки профиля и счётчик тарифа.
 *
 * Клиент (Happ, v2rayNG, Streisand) рисует карточку подписки из заголовков
 * ответа `/sub/<token>`. Если их нет, человек видит безымянный список узлов
 * и «0 Б / 0 Б» — так выглядят бесплатные сборки. Здесь собирается то, что
 * делает карточку похожей на купленный тариф: имя, срок, объём, ссылка на
 * страницу сервиса и поддержку.
 *
 * Все значения — обычные заголовки протокола подписки, никаких обещаний
 * клиенту не добавляется: если у человека в базе свой лимит и срок, они
 * имеют приоритет над значениями по умолчанию.
 */

import { BRAND_PREMIUM } from "./brand";
import type { UserRow } from "./types";

/** Объём «тарифа» по умолчанию, ГБ. */
export const DEFAULT_TRAFFIC_GB = 500;

/** Срок «тарифа» по умолчанию, дней вперёд. */
export const DEFAULT_PLAN_DAYS = 365;

export interface PlanDefaults {
  /** Показывать ли тариф, когда в базе пусто. */
  enabled: boolean;
  /** Объём, ГБ. */
  trafficGb: number;
  /** Срок, дней. */
  days: number;
}

/** Настройки тарифа из окружения; всё необязательное. */
export function planDefaults(env: {
  PREMIUM_LOOK?: string;
  PREMIUM_TRAFFIC_GB?: string;
  PREMIUM_PLAN_DAYS?: string;
}): PlanDefaults {
  const enabled = (env.PREMIUM_LOOK ?? "1").trim() !== "0";
  const gb = Number(env.PREMIUM_TRAFFIC_GB ?? "");
  const days = Number(env.PREMIUM_PLAN_DAYS ?? "");
  return {
    enabled,
    trafficGb: Number.isFinite(gb) && gb > 0 ? gb : DEFAULT_TRAFFIC_GB,
    days: Number.isFinite(days) && days > 0 ? Math.round(days) : DEFAULT_PLAN_DAYS,
  };
}

/** Срок из базы в секундах Unix. 0 — срока нет. */
export function expirySeconds(user: Pick<UserRow, "expires_at">): number {
  if (!user.expires_at) return 0;
  // D1 отдаёт «2026-11-02 10:00:00» без зоны — это UTC.
  const ts = Date.parse(`${user.expires_at.replace(" ", "T")}Z`);
  return Number.isFinite(ts) ? Math.floor(ts / 1000) : 0;
}

/**
 * Значение `subscription-userinfo`.
 *
 * `download=0` — не враньё про расход: воркер не видит трафик через чужие
 * узлы, поэтому честно показывает ноль потраченного при большом остатке.
 * Если в базе задан свой лимит или срок, берутся они.
 */
export function subscriptionUserinfo(
  user: Pick<UserRow, "traffic_gb" | "expires_at">,
  defaults: PlanDefaults,
  now = Date.now(),
): string {
  const ownGb = Number(user.traffic_gb ?? 0);
  const gb = ownGb > 0 ? ownGb : defaults.enabled ? defaults.trafficGb : 0;
  const total = Math.max(0, Math.round(gb * 1024 ** 3));

  const ownExpire = expirySeconds(user);
  const fallbackExpire = defaults.enabled
    ? Math.floor((now + defaults.days * 86_400_000) / 1000)
    : 0;

  return `upload=0; download=0; total=${total}; expire=${ownExpire || fallbackExpire}`;
}

/**
 * Заголовки карточки подписки.
 *
 * `profile-title` — название, `profile-web-page-url` — кнопка «сайт» в Happ,
 * `support-url` — кнопка поддержки. Пустые значения не отдаём: клиент
 * нарисует пустую кнопку.
 */
export function premiumHeaders(options: {
  baseUrl: string;
  botUsername: string;
  refreshHours: number;
  title?: string;
}): Record<string, string> {
  const headers: Record<string, string> = {
    "profile-title": options.title?.trim() || BRAND_PREMIUM,
    "profile-update-interval": String(options.refreshHours),
  };
  const base = options.baseUrl.trim().replace(/\/+$/, "");
  if (/^https?:\/\//i.test(base)) headers["profile-web-page-url"] = `${base}/`;
  const bot = options.botUsername.trim().replace(/^@/, "");
  if (bot) headers["support-url"] = `https://t.me/${bot}`;
  return headers;
}
