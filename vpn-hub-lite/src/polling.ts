/**
 * Резервный транспорт бота: getUpdates по cron раз в минуту.
 *
 * Нужен, когда Telegram не может достучаться до воркера: он не резолвит
 * домены `*.workers.dev` и отвечает «Failed to resolve host». Логика команд
 * та же, что у вебхука — просто обновления забираем сами.
 *
 * Включается переменной BOT_TRANSPORT=polling в wrangler.toml.
 */

import { one, run } from "./db";
import { tgApi, tgRaw } from "./bot/telegram";
import { handleUpdate, type TgUpdate } from "./bot";
import { logEvent } from "./db";
import type { Env } from "./types";

const OFFSET_KEY = "tg_offset";
// 5, а не 10: обработка одного апдейта теперь делает больше запросов к D1
// (бонус, кабинет, группы), а лимит — 50 запросов на инвокацию.
const MAX_UPDATES = 5;

/**
 * Страховка вебхука: раз в минуту смотрим, доставляет ли Telegram.
 * Если копятся необработанные апдейты или есть ошибка доставки — снимаем
 * вебхук и разбираем очередь опросом, чтобы бот не замолчал совсем.
 */
export async function watchWebhook(env: Env): Promise<void> {
  const info = await tgRaw<{ pending_update_count?: number; last_error_message?: string }>(
    env,
    "getWebhookInfo",
  );
  if (!info.ok) return;

  const pending = Number(info.result?.pending_update_count ?? 0);
  const error = info.result?.last_error_message ?? "";
  // Порог 10, чтобы всплеск сообщений не принимался за поломку доставки.
  if (!error && pending < 10) return;

  await logEvent(env, "webhook_down", null, `в очереди ${pending}${error ? `, ${error}` : ""}`);
  await tgRaw(env, "deleteWebhook", { drop_pending_updates: false });
  await runPoll(env);
}

export async function runPoll(env: Env): Promise<number> {
  const row = await one<{ value: string }>(
    env,
    "SELECT value FROM bot_state WHERE key = ?",
    OFFSET_KEY,
  );
  const offset = Number(row?.value ?? "0") || 0;

  const updates = await tgApi<TgUpdate[]>(env, "getUpdates", {
    offset,
    limit: MAX_UPDATES,
    timeout: 0,
    allowed_updates: ["message", "callback_query"],
  });

  if (!updates || !updates.length) return 0;

  let next = offset;
  let processed = 0;
  for (const update of updates) {
    const id = (update as unknown as { update_id?: number }).update_id ?? 0;
    if (id >= next) next = id + 1;
    try {
      await handleUpdate(env, update);
      processed += 1;
    } catch (error) {
      console.error(
        "poll update failed",
        error instanceof Error ? error.message : error,
      );
    }
  }

  await run(
    env,
    `INSERT INTO bot_state (key, value) VALUES (?, ?)
     ON CONFLICT (key) DO UPDATE SET value = excluded.value`,
    OFFSET_KEY,
    String(next),
  );

  if (processed > 0) {
    await logEvent(env, "poll", null, `обработано обновлений: ${processed}`);
  }
  return processed;
}
