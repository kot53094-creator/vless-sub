/** Минимальный клиент Bot API. Каждый вызов — один подзапрос (лимит 50). */

import { one } from "../db";
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
  if (!env.BOT_TOKEN) return null;
  try {
    const response = await fetch(`${API}${env.BOT_TOKEN}/${method}`, {
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

export async function sendMessage(
  env: Env,
  chatId: number | string,
  text: string,
  keyboard?: ReplyMarkup,
): Promise<boolean> {
  const result = await tgApi(env, "sendMessage", {
    chat_id: chatId,
    text: text.slice(0, 4000),
    parse_mode: "HTML",
    disable_web_page_preview: true,
    ...(keyboard ? { reply_markup: keyboard } : {}),
  });
  return result !== null;
}

export function adminId(env: Env): string {
  return String(env.ADMIN_TG_ID ?? "8938447065");
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
): Promise<void> {
  await tgApi(env, "answerCallbackQuery", {
    callback_query_id: callbackId,
    text: text.slice(0, 190),
    show_alert: false,
  });
}
