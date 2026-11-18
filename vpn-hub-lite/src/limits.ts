/**
 * Лимиты, которые применяются и в выдаче подписки, и в кабинете, и в API.
 *
 * Вынесено отдельно, чтобы `sub.ts` (выдача) и `app_api.ts` (кабинет)
 * считали лимит устройств одинаково. Если бы правило жило в одном из них,
 * второй рано или поздно начал бы показывать другое число, и человек увидел
 * бы «2 из 3», стоя перед заглушкой «лимит 2».
 */

import type { Env, UserRow } from "./types";

/** Лимит устройств: из тарифа, иначе из окружения, иначе два. */
export function deviceLimitOf(user: Pick<UserRow, "device_limit"> | null, env: Env): number {
  const raw = Number(env.DEVICE_LIMIT ?? "");
  const fallback = Number.isFinite(raw) && raw > 0 ? Math.round(raw) : 2;
  const own = Number(user?.device_limit ?? 0);
  const limit = Number.isFinite(own) && own > 0 ? own : fallback;
  return Math.min(Math.max(Math.round(limit), 1), 10);
}

/** Сколько трафика осталось, ГБ. `null` — без лимита. */
/**
 * Полная квота трафика: тарифная плюс докупленная.
 *
 * `null` — безлимит. Ноль в базе исторически означает «без лимита», поэтому
 * докупка имеет смысл только когда база задана: иначе человек платил бы за
 * гигабайты, которых у него и так бесконечно.
 */
export function trafficQuotaGb(
  user: Pick<UserRow, "traffic_gb" | "traffic_extra_gb">,
): number | null {
  const base = Number(user.traffic_gb ?? 0);
  const extra = Math.max(0, Number(user.traffic_extra_gb ?? 0));
  if (!Number.isFinite(base) || base <= 0) return null;
  return base + extra;
}

export function trafficLeftGb(
  user: Pick<UserRow, "traffic_gb" | "traffic_used_mb" | "traffic_extra_gb">,
): number | null {
  const quota = trafficQuotaGb(user);
  if (quota === null) return null;
  const used = Math.max(0, Number(user.traffic_used_mb ?? 0)) / 1024;
  return Math.max(0, Math.round((quota - used) * 10) / 10);
}
