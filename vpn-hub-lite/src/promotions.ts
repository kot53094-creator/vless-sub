/**
 * Чистые функции бонусной механики: сутки по Москве, серии, потолки, коды.
 * Здесь нет обращений к D1 — поэтому всё это покрывается юнит-тестами.
 */

export const MSK_TZ = "Europe/Moscow";

const dateFmt = new Intl.DateTimeFormat("en-CA", {
  timeZone: MSK_TZ,
  year: "numeric",
  month: "2-digit",
  day: "2-digit",
});

/** 2026-10-21 — «сегодня» по Москве. */
export function mskDate(ts: number = Date.now()): string {
  return dateFmt.format(new Date(ts));
}

/** YYYY-MM по Москве — для месячных потолков. */
export function mskMonth(ts: number = Date.now()): string {
  return mskDate(ts).slice(0, 7);
}

/** Сдвиг календарной даты на N дней (работает по UTC-полуночи, без DST-сюрпризов). */
export function shiftDate(date: string, days: number): string {
  const [y, m, d] = date.split("-").map(Number);
  const base = Date.UTC(y, (m ?? 1) - 1, d ?? 1);
  return new Date(base + days * 86400_000).toISOString().slice(0, 10);
}

/** Сколько дней между двумя датами (b - a). */
export function daysBetween(a: string, b: string): number {
  const left = Date.parse(`${a}T00:00:00Z`);
  const right = Date.parse(`${b}T00:00:00Z`);
  if (!Number.isFinite(left) || !Number.isFinite(right)) return 0;
  return Math.round((right - left) / 86400_000);
}

/**
 * Серия: если последний сбор был вчера — продолжаем, иначе начинаем с 1.
 * Повторный сбор в тот же день ловится раньше (UNIQUE по user_id+claim_date).
 */
export function nextStreak(lastClaimDate: string | null, lastStreak: number, today: string): number {
  if (!lastClaimDate) return 1;
  const diff = daysBetween(lastClaimDate, today);
  if (diff === 1) return Math.max(1, lastStreak) + 1;
  if (diff === 0) return Math.max(1, lastStreak);
  return 1;
}

/** Сколько часов даём за такой день серии. 3-й и 7-й (и кратные) — повышенные. */
export function streakHours(
  streak: number,
  base: number,
  thirdDay: number,
  seventhDay: number,
): number {
  if (streak > 0 && streak % 7 === 0) return seventhDay;
  if (streak > 0 && streak % 3 === 0) return thirdDay;
  return base;
}

/**
 * Сколько реально можно начислить с учётом месячного потолка.
 * Возвращает 0, если потолок уже выбран.
 */
export function clampToCap(usedHours: number, capHours: number, wantHours: number): number {
  if (!Number.isFinite(wantHours) || wantHours <= 0) return 0;
  const left = round2(capHours - usedHours);
  if (left <= 0) return 0;
  return round2(Math.min(wantHours, left));
}

export function round2(value: number): number {
  return Math.round(value * 100) / 100;
}

/** Короткий код приглашения: base36 от id пользователя. */
export function refCode(userId: number): string {
  return Math.max(1, Math.floor(userId)).toString(36);
}

export function parseRefCode(code: string): number | null {
  const clean = code.trim().toLowerCase();
  if (!/^[0-9a-z]{1,10}$/.test(clean)) return null;
  const id = parseInt(clean, 36);
  return Number.isFinite(id) && id > 0 ? id : null;
}

/** «1 ч 30 мин», «2 дня», «45 мин». */
export function humanDuration(hours: number): string {
  if (!Number.isFinite(hours) || hours <= 0) return "0 мин";
  if (hours >= 24 && hours % 24 === 0) {
    const days = hours / 24;
    return `${days} ${plural(days, "день", "дня", "дней")}`;
  }
  const whole = Math.floor(hours);
  const minutes = Math.round((hours - whole) * 60);
  if (whole <= 0) return `${minutes} мин`;
  if (minutes === 0) return `${whole} ч`;
  return `${whole} ч ${minutes} мин`;
}

export function plural(n: number, one: string, few: string, many: string): string {
  const mod10 = n % 10;
  const mod100 = n % 100;
  if (mod10 === 1 && mod100 !== 11) return one;
  if (mod10 >= 2 && mod10 <= 4 && (mod100 < 10 || mod100 >= 20)) return few;
  return many;
}

/** Промокоды: без пробелов, в верхнем регистре. */
export function normalizePromo(raw: string): string {
  return raw.trim().toUpperCase().replace(/[^A-Z0-9_-]/g, "").slice(0, 32);
}

/** «/promo abc» → «ABC»; иначе null. */
export function parsePromoCommand(text: string): string | null {
  const match = text.trim().match(/^\/promo(?:@\w+)?\s+(\S+)/i);
  return match ? normalizePromo(match[1] ?? "") : null;
}

/** Сгенерировать код: 8 символов без похожих друг на друга (0/O, 1/I). */
export function randomPromoCode(length = 8): string {
  const alphabet = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
  const bytes = new Uint8Array(length);
  crypto.getRandomValues(bytes);
  let out = "";
  for (const byte of bytes) out += alphabet[byte % alphabet.length];
  return out;
}

/** Расширить срок: если он в прошлом — считаем от сейчас. */
export function extendExpiry(current: string | null, hours: number, now: number = Date.now()): string {
  const base = current ? Date.parse(`${current.replace(" ", "T")}Z`) : NaN;
  const from = Number.isFinite(base) && base > now ? base : now;
  const next = new Date(from + hours * 3600_000);
  return next.toISOString().replace("T", " ").slice(0, 19);
}

/** Разбор «YYYY-MM-DD HH:MM:SS» (UTC) в миллисекунды. */
export function parseTs(value: string | null): number | null {
  if (!value) return null;
  const ts = Date.parse(`${value.replace(" ", "T")}Z`);
  return Number.isFinite(ts) ? ts : null;
}
