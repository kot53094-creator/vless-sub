/**
 * Баннеры экранов бота.
 *
 * Схема: PNG лежит в KV (`banner:<key>`), а в D1 хранится только file_id,
 * который Telegram вернул при первой загрузке. Дальше отправка идёт по
 * file_id — это один сабреквест и никакого трафика картинки.
 */

import { logEvent, many, one, run } from "./db";
import type { Env } from "./types";
import { sendMessage, tgApi, tgMultipart, type ReplyMarkup } from "./bot/telegram";

export const BANNER_KEYS = [
  "start",
  "trial",
  "channel",
  "devices",
  "account",
  "activated",
  "expiring",
] as const;

export type BannerKey = (typeof BANNER_KEYS)[number];

export const BANNER_LABELS: Record<BannerKey, string> = {
  start: "1 · Старт (/start)",
  trial: "2 · Пробный период",
  channel: "3 · Проверка канала",
  devices: "4 · Выбор устройства",
  account: "5 · Кабинет",
  activated: "6 · Подписка активирована",
  expiring: "7 · Подписка заканчивается",
};

export function isBannerKey(value: string): value is BannerKey {
  return (BANNER_KEYS as readonly string[]).includes(value);
}

interface TgPhotoSize {
  file_id: string;
  width: number;
  height: number;
}

interface TgMessage {
  message_id: number;
  photo?: TgPhotoSize[];
}

const KV_PREFIX = "banner:";

export async function saveBannerFile(
  env: Env,
  key: BannerKey,
  bytes: ArrayBuffer,
  contentType = "image/png",
): Promise<void> {
  await env.CACHE.put(`${KV_PREFIX}${key}`, bytes, {
    metadata: { contentType, size: bytes.byteLength },
  });
  // Старый file_id больше не актуален — фото другое.
  await run(
    env,
    "UPDATE banners SET file_id = '', updated_at = datetime('now') WHERE key = ?",
    key,
  );
  await logEvent(env, "banner_upload", null, `${key}: ${Math.round(bytes.byteLength / 1024)} КБ`);
}

export async function resetBannerFile(env: Env, key: BannerKey): Promise<void> {
  await run(env, "UPDATE banners SET file_id = '', updated_at = datetime('now') WHERE key = ?", key);
}

export async function bannerRows(
  env: Env,
): Promise<Array<{ key: string; file_id: string; updated_at: string }>> {
  return await many<{ key: string; file_id: string; updated_at: string }>(
    env,
    "SELECT key, file_id, updated_at FROM banners ORDER BY key",
  );
}

async function fileIdFor(env: Env, key: BannerKey): Promise<string> {
  const row = await one<{ file_id: string }>(
    env,
    "SELECT file_id FROM banners WHERE key = ?",
    key,
  );
  return row?.file_id ?? "";
}

async function rememberFileId(env: Env, key: BannerKey, fileId: string): Promise<void> {
  await run(
    env,
    `INSERT INTO banners (key, file_id, updated_at) VALUES (?, ?, datetime('now'))
     ON CONFLICT (key) DO UPDATE SET file_id = excluded.file_id, updated_at = datetime('now')`,
    key,
    fileId,
  );
}

function largestPhoto(message: TgMessage | null): string {
  const sizes = message?.photo ?? [];
  return sizes.length ? sizes[sizes.length - 1].file_id : "";
}

/** Отправить баннер новым сообщением. false — значит, ушёл обычный текст. */
export async function sendBanner(
  env: Env,
  chatId: number | string,
  key: BannerKey,
  caption: string,
  keyboard?: ReplyMarkup,
): Promise<boolean> {
  const text = caption.slice(0, 1020);
  const fileId = await fileIdFor(env, key);

  if (fileId) {
    const sent = await tgApi<TgMessage>(env, "sendPhoto", {
      chat_id: chatId,
      photo: fileId,
      caption: text,
      parse_mode: "HTML",
      ...(keyboard ? { reply_markup: keyboard } : {}),
    });
    if (sent) return true;
    // file_id протух — идём загружать заново.
    await resetBannerFile(env, key);
  }

  const bytes = await env.CACHE.get(`${KV_PREFIX}${key}`, "arrayBuffer");
  if (bytes && bytes.byteLength > 0) {
    const form = new FormData();
    form.append("chat_id", String(chatId));
    form.append("caption", text);
    form.append("parse_mode", "HTML");
    if (keyboard) form.append("reply_markup", JSON.stringify(keyboard));
    form.append("photo", new Blob([bytes], { type: "image/png" }), `${key}.png`);

    const uploaded = await tgMultipart<TgMessage>(env, "sendPhoto", form);
    const fresh = largestPhoto(uploaded.result ?? null);
    if (uploaded.ok && fresh) {
      await rememberFileId(env, key, fresh);
      return true;
    }
    await logEvent(env, "banner_fail", null, `${key}: ${uploaded.description ?? "нет ответа"}`);
  }

  return await sendMessage(env, chatId, caption, keyboard);
}

/**
 * Заменить текущий экран, не плодя сообщения.
 * Возвращает false, если отредактировать нельзя — тогда caller отправит новое.
 */
export async function editBanner(
  env: Env,
  chatId: number | string,
  messageId: number,
  key: BannerKey,
  caption: string,
  keyboard?: ReplyMarkup,
): Promise<boolean> {
  const fileId = await fileIdFor(env, key);
  if (!fileId) return false;

  const result = await tgApi(env, "editMessageMedia", {
    chat_id: chatId,
    message_id: messageId,
    media: {
      type: "photo",
      media: fileId,
      caption: caption.slice(0, 1020),
      parse_mode: "HTML",
    },
    ...(keyboard ? { reply_markup: keyboard } : {}),
  });
  return result !== null;
}

/** Текстовая замена того же сообщения (для экранов без картинки). */
export async function editText(
  env: Env,
  chatId: number | string,
  messageId: number,
  text: string,
  keyboard?: ReplyMarkup,
): Promise<boolean> {
  const result = await tgApi(env, "editMessageText", {
    chat_id: chatId,
    message_id: messageId,
    text: text.slice(0, 4000),
    parse_mode: "HTML",
    disable_web_page_preview: true,
    ...(keyboard ? { reply_markup: keyboard } : {}),
  });
  return result !== null;
}
