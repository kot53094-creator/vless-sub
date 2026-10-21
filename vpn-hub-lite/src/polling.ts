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
import { tgApi } from "./bot/telegram";
import { handleUpdate, type TgUpdate } from "./bot";
import { logEvent } from "./db";
import type { Env } from "./types";

const OFFSET_KEY = "tg_offset";
// 5, а не 10: обработка одного апдейта теперь делает больше запросов к D1
// (бонус, кабинет, группы), а лимит — 50 запросов на инвокацию.
const MAX_UPDATES = 5;

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
