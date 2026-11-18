/**
 * Аутентификация Telegram Mini App через initData.
 *
 * Согласно спецификации Telegram Web Apps:
 * 1. Строка initData разбирается на пары key=value.
 * 2. Поле hash извлекается.
 * 3. Оставшиеся поля сортируются по алфавиту и склеиваются через \n в data-check-string.
 * 4. secret_key = HMAC-SHA256("WebAppData", bot_token).
 * 5. calculated_hash = HMAC-SHA256(secret_key, data-check-string).
 * 6. Если calculated_hash совпадает с hash — данные подлинные.
 * 7. Внутри извлекается объект user (id, username, first_name и др.).
 */

import { one, run } from "./db";
import { envStr, timingSafeEqual, randomToken } from "./security";
import type { Env, UserRow } from "./types";

export interface TgWebUser {
  id: number;
  first_name?: string;
  last_name?: string;
  username?: string;
  language_code?: string;
  photo_url?: string;
  is_premium?: boolean;
}

export interface WebAppAuthResult {
  ok: boolean;
  user?: TgWebUser;
  authDate?: number;
  error?: string;
}

/** Преобразование hex в ArrayBuffer. */
function hexToBytes(hex: string): Uint8Array {
  const bytes = new Uint8Array(hex.length / 2);
  for (let i = 0; i < hex.length; i += 2) {
    bytes[i / 2] = parseInt(hex.substring(i, i + 2), 16);
  }
  return bytes;
}

/** Преобразование ArrayBuffer в hex. */
function bytesToHex(bytes: Uint8Array): string {
  return Array.from(bytes)
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

/**
 * Проверка валидности Telegram initData.
 */
export async function verifyTelegramInitData(
  initData: string,
  botToken: string,
  maxAgeSeconds = 86400 * 3, // 3 суток
): Promise<WebAppAuthResult> {
  if (!initData || !botToken) {
    return { ok: false, error: "missing_data" };
  }

  try {
    const params = new URLSearchParams(initData);
    const hash = params.get("hash");
    if (!hash) return { ok: false, error: "no_hash" };

    const authDateStr = params.get("auth_date");
    const authDate = authDateStr ? parseInt(authDateStr, 10) : 0;
    if (authDate > 0 && maxAgeSeconds > 0) {
      const now = Math.floor(Date.now() / 1000);
      if (now - authDate > maxAgeSeconds) {
        return { ok: false, error: "initdata_expired" };
      }
    }

    params.delete("hash");

    // Сортировка ключей
    const keys = Array.from(params.keys()).sort();
    const dataCheckString = keys.map((key) => `${key}=${params.get(key)}`).join("\n");

    const encoder = new TextEncoder();

    // 1. secret_key = HMAC_SHA256("WebAppData", botToken)
    const webAppDataKey = await crypto.subtle.importKey(
      "raw",
      encoder.encode("WebAppData"),
      { name: "HMAC", hash: "SHA-256" },
      false,
      ["sign"],
    );
    const secretKeyBytes = await crypto.subtle.sign("HMAC", webAppDataKey, encoder.encode(botToken));

    // 2. calculated_hash = HMAC_SHA256(secret_key, dataCheckString)
    const checkKey = await crypto.subtle.importKey(
      "raw",
      secretKeyBytes,
      { name: "HMAC", hash: "SHA-256" },
      false,
      ["sign"],
    );
    const calculatedHashBuffer = await crypto.subtle.sign(
      "HMAC",
      checkKey,
      encoder.encode(dataCheckString),
    );
    const calculatedHash = bytesToHex(new Uint8Array(calculatedHashBuffer));

    if (!timingSafeEqual(calculatedHash.toLowerCase(), hash.toLowerCase())) {
      return { ok: false, error: "invalid_hash" };
    }

    const userJson = params.get("user");
    let user: TgWebUser | undefined;
    if (userJson) {
      try {
        user = JSON.parse(userJson) as TgWebUser;
      } catch {
        // user string could not be parsed
      }
    }

    return { ok: true, user, authDate };
  } catch (err) {
    return { ok: false, error: String(err) };
  }
}

/**
 * Аутентифицировать пользователя Mini App из Request и получить / создать запись в БД.
 */
export async function authenticateAppUser(
  env: Env,
  request: Request,
): Promise<{ ok: boolean; user?: UserRow; tgUser?: TgWebUser; error?: string }> {
  const authHeader = request.headers.get("x-telegram-init-data") || "";
  const tokenHeader = request.headers.get("x-sub-token") || "";

  // 1. Попытка аутентификации через Telegram initData
  if (authHeader) {
    const botToken = envStr(env.BOT_TOKEN);
    const verification = await verifyTelegramInitData(authHeader, botToken);

    if (verification.ok && verification.user?.id) {
      const tgId = String(verification.user.id);
      let user = await one<UserRow>(env, "SELECT * FROM users WHERE tg_id = ?", tgId);

      // Если пользователя нет в базе — регистрируем с начальным доступом
      if (!user) {
        const subToken = randomToken(16);
        const expiresDays = Number(envStr(env.PREMIUM_PLAN_DAYS) || "30") || 30;
        const expiresAt = new Date(Date.now() + expiresDays * 86400_000)
          .toISOString()
          .replace("T", " ")
          .slice(0, 19);

        await run(
          env,
          `INSERT INTO users (tg_id, tg_username, status, expires_at, sub_token, tier, device_limit)
           VALUES (?, ?, 'active', ?, ?, 'free', 3)`,
          tgId,
          verification.user.username || verification.user.first_name || "",
          expiresAt,
          subToken,
        );

        user = await one<UserRow>(env, "SELECT * FROM users WHERE tg_id = ?", tgId);
      } else if (verification.user.username && user.tg_username !== verification.user.username) {
        // Обновляем актуальный юзернейм
        await run(
          env,
          "UPDATE users SET tg_username = ? WHERE id = ?",
          verification.user.username,
          user.id,
        );
        user.tg_username = verification.user.username;
      }

      if (user) {
        return { ok: true, user, tgUser: verification.user };
      }
    }
  }

  // 2. Запасной вариант аутентификации по персональному токену подписки (sub_token)
  const url = new URL(request.url);
  const tokenParam = url.searchParams.get("token") || tokenHeader;
  if (tokenParam) {
    const user = await one<UserRow>(env, "SELECT * FROM users WHERE sub_token = ?", tokenParam);
    if (user) {
      return {
        ok: true,
        user,
        tgUser: { id: Number(user.tg_id) || 0, username: user.tg_username },
      };
    }
  }

  return { ok: false, error: "unauthorized" };
}
