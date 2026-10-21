/** Минимальный клиент Bot API. Каждый вызов — один подзапрос (лимит 50). */

import { logEvent, one } from "../db";
import { envStr } from "../security";
import type { Env } from "../types";

const API = "https://api.telegram.org/bot";

export interface InlineButton {
  text: string;
  callback_data?: string;
  url?: string;
}

export interface ReplyMarkup {
  inline_keyboard: InlineButton[][];
}

export function escapeHtml(value: string): string {
  return value.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

export async function tgApi<T>(
  env: Env,
  method: string,
  payload?: Record<string, unknown>,
): Promise<T | null> {
  const token = envStr(env.BOT_TOKEN);
  if (!token) return null;
  try {
    const response = await fetch(`${API}${token}/${method}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(payload ?? {}),
    });
    const data = (await response.json()) as { ok: boolean; result?: T };
    return data.ok ? (data.result ?? null) : null;
  } catch {
    return null;
  }
}

/** Сырой ответ Bot API — нужен для диагностики (getMe, getWebhookInfo). */
export async function tgRaw<T = unknown>(
  env: Env,
  method: string,
  payload?: Record<string, unknown>,
): Promise<{ ok: boolean; result?: T; description?: string; error_code?: number }> {
  const token = envStr(env.BOT_TOKEN);
  if (!token) return { ok: false, description: "BOT_TOKEN не задан" };
  try {
    const response = await fetch(`${API}${token}/${method}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(payload ?? {}),
    });
    return (await response.json()) as {
      ok: boolean;
      result?: T;
      description?: string;
      error_code?: number;
    };
  } catch (error) {
    return {
      ok: false,
      description: error instanceof Error ? error.message : "network error",
    };
  }
}

/** Multipart-вызов: нужен для загрузки фото, когда file_id ещё нет. */
export async function tgMultipart<T>(
  env: Env,
  method: string,
  form: FormData,
): Promise<{ ok: boolean; result?: T; description?: string }> {
  const token = envStr(env.BOT_TOKEN);
  if (!token) return { ok: false, description: "BOT_TOKEN не задан" };
  try {
    const response = await fetch(`${API}${token}/${method}`, {
      method: "POST",
      body: form,
    });
    return (await response.json()) as { ok: boolean; result?: T; description?: string };
  } catch (error) {
    return {
      ok: false,
      description: error instanceof Error ? error.message : "network error",
    };
  }
}

export async function sendMessage(
  env: Env,
  chatId: number | string,
  text: string,
  keyboard?: ReplyMarkup,
): Promise<boolean> {
  const payload = {
    chat_id: chatId,
    text: text.slice(0, 4000),
    parse_mode: "HTML",
    disable_web_page_preview: true,
    ...(keyboard ? { reply_markup: keyboard } : {}),
  };
  const result = await tgApi(env, "sendMessage", payload);
  if (result === null) {
    // Молчаливое «бот не ответил» — худший вид бага: пишем причину в журнал.
    const raw = await tgRaw(env, "sendMessage", payload);
    await logEvent(
      env,
      "tg_send_fail",
      null,
      `chat ${chatId}: ${raw.description ?? "unknown"}`.slice(0, 300),
    );
  }
  return result !== null;
}

export function adminId(env: Env): string {
  return String(env.ADMIN_TG_ID ?? "5680608085").trim();
}

export async function sendToAdmin(env: Env, text: string): Promise<void> {
  await sendMessage(env, adminId(env), text);
}

export async function notifyUser(
  env: Env,
  userId: number,
  text: string,
): Promise<void> {
  const user = await one<{ tg_id: string; status: string }>(
    env,
    "SELECT tg_id, status FROM users WHERE id = ?",
    userId,
  );
  if (!user || user.status === "banned") return;
  await sendMessage(env, user.tg_id, text);
}

export async function answerCallback(
  env: Env,
  callbackId: string,
  text: string,
  alert = false,
): Promise<void> {
  await tgApi(env, "answerCallbackQuery", {
    callback_query_id: callbackId,
    text: text.slice(0, 190),
    show_alert: alert,
  });
}
