/**
 * Подарочные коды: выдать N дней, активировать один раз.
 *
 * Логика намеренно короткая. Главное здесь — не генерация, а два ограничения:
 *   1. код одноразовый (атомарный UPDATE, а не «проверил и записал»);
 *   2. срок действия проверяется до начисления, иначе подарочный код,
 *      выданный год назад, сработает в самый неудобный момент.
 */

import { many, one, run } from "./db";
import { applyAccrual } from "./bonus";
import { randomToken } from "./security";
import type { Env } from "./types";

export interface GiftCode {
  id: number;
  code: string;
  days: number;
  note: string;
  created_at: string;
  expires_at: string | null;
  redeemed_by: number | null;
  redeemed_at: string | null;
}

/** Код без похожих символов: 0/O, 1/I/L — их диктуют по телефону и путают. */
function readableCode(): string {
  const alphabet = "ABCDEFGHJKMNPQRSTUVWXYZ23456789";
  let out = "";
  const raw = randomToken(10).toUpperCase().replace(/[^A-Z0-9]/g, "");
  for (const char of raw) {
    if (out.length >= 8) break;
    const index = char.charCodeAt(0) % alphabet.length;
    out += alphabet[index];
  }
  return out.slice(0, 4) + "-" + out.slice(4, 8);
}

export async function createGift(
  env: Env,
  days: number,
  options: { count?: number; note?: string; createdBy?: number; validDays?: number } = {},
): Promise<GiftCode[]> {
  const count = Math.min(Math.max(Math.trunc(options.count ?? 1), 1), 20);
  const expiresAt =
    options.validDays && options.validDays > 0
      ? new Date(Date.now() + options.validDays * 86_400_000)
          .toISOString()
          .slice(0, 19)
          .replace("T", " ")
      : null;

  const created: GiftCode[] = [];
  for (let index = 0; index < count; index += 1) {
    for (let attempt = 0; attempt < 4; attempt += 1) {
      const code = readableCode();
      try {
        await run(
          env,
          `INSERT INTO gift_codes (code, days, note, created_by, expires_at)
           VALUES (?, ?, ?, ?, ?)`,
          code,
          Math.min(Math.max(Math.trunc(days), 1), 3650),
          (options.note ?? "").slice(0, 120),
          options.createdBy ?? null,
          expiresAt,
        );
        const row = await one<GiftCode>(
          env,
          "SELECT * FROM gift_codes WHERE code = ?",
          code,
        );
        if (row) {
          created.push(row);
          break;
        }
      } catch {
        // коллизия или недоступная база — пробуем другой код
      }
    }
  }
  return created;
}

export interface RedeemResult {
  ok: boolean;
  days?: number;
  expiresAt?: string | null;
  error?: string;
}

/**
 * Активация кода.
 *
 * Порядок: сначала «занять» код условным UPDATE, потом начислить дни. Если
 * начисление упадёт, код останется занятым — это лучше, чем наоборот:
 * потерянные дни разбираются вручную, а бесконечный код — дыра в экономике.
 */
export async function redeemGift(
  env: Env,
  codeRaw: string,
  user: { id: number; tg_id: string },
): Promise<RedeemResult> {
  const code = codeRaw.trim().toUpperCase().replace(/\s+/g, "");
  if (!code) return { ok: false, error: "Код пустой" };

  // Таблица может отсутствовать, если миграция ещё не применена (например,
  // D1 в суточном лимите). Отвечаем понятным текстом вместо падения бота.
  let gift: GiftCode | null = null;
  try {
    gift = await one<GiftCode>(env, "SELECT * FROM gift_codes WHERE code = ?", code);
  } catch {
    return { ok: false, error: "Подарочные коды временно недоступны, попробуйте позже" };
  }
  if (!gift) return { ok: false, error: "Код не найден" };
  if (gift.redeemed_by) return { ok: false, error: "Код уже активирован" };
  if (gift.expires_at) {
    const until = Date.parse(gift.expires_at.replace(" ", "T") + "Z");
    if (Number.isFinite(until) && until < Date.now()) {
      return { ok: false, error: "Срок действия кода истёк" };
    }
  }

  const claimed = await run(
    env,
    `UPDATE gift_codes
        SET redeemed_by = ?, redeemed_at = datetime('now'), redeemed_tg = ?
      WHERE code = ? AND redeemed_by IS NULL`,
    user.id,
    String(user.tg_id),
    code,
  );
  if (!(claimed.meta?.changes ?? 0)) {
    return { ok: false, error: "Код уже активирован" };
  }

  try {
    const outcome = await applyAccrual(env, {
      userId: user.id,
      kind: "promo",
      ref: `gift:${code}`,
      days: gift.days,
      note: gift.note || "подарочный код",
    });
    return { ok: true, days: gift.days, expiresAt: outcome.expiresAt };
  } catch {
    return { ok: false, error: "Не удалось начислить дни — напишите в поддержку" };
  }
}

export async function listGifts(env: Env, limit = 10): Promise<GiftCode[]> {
  try {
    return await many<GiftCode>(
      env,
      "SELECT * FROM gift_codes ORDER BY id DESC LIMIT ?",
      Math.min(Math.max(limit, 1), 50),
    );
  } catch {
    return [];
  }
}
