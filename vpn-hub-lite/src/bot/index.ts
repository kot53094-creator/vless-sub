/** Роутер обновлений Telegram. Команды только из личных чатов. */

import { logEvent, one } from "../db";
import { memRateLimit } from "../security";
import type { Env, UserRow } from "../types";
import * as admin from "./admin";
import { answerCallback, adminId, sendMessage } from "./telegram";
import * as user from "./user";

interface TgMessage {
  message_id: number;
  chat: { id: number; type: string };
  from?: { id: number; username?: string; first_name?: string };
  text?: string;
}

export interface TgUpdate {
  message?: TgMessage;
  callback_query?: {
    id: string;
    data?: string;
    from: { id: number };
    message?: { chat: { id: number } };
  };
}

function chatOf(env: Env): string {
  return adminId(env);
}

export async function handleUpdate(env: Env, update: TgUpdate): Promise<void> {
  if (update.callback_query) {
    await handleCallback(env, update.callback_query);
    return;
  }

  const message = update.message;
  if (!message || message.chat.type !== "private" || !message.from) return;

  const tgId = String(message.from.id);
  // анти-спам: 20 команд в минуту с одного аккаунта
  if (!memRateLimit(`tg:${tgId}`, 20, 60)) return;

  const text = (message.text ?? "").trim();
  if (!text) return;

  const isAdmin = tgId === adminId(env);
  const existing = await user.findUser(env, tgId);

  if (!text.startsWith("/")) {
    if (isAdmin && (await env.CACHE.get(`state:addkey:${tgId}`))) {
      await env.CACHE.delete(`state:addkey:${tgId}`);
      const reply = await admin.addKeys(env, text);
      await sendMessage(env, message.chat.id, reply);
      return;
    }
    return;
  }

  const [rawCommand, ...args] = text.split(/\s+/);
  const command = (rawCommand ?? "").split("@")[0].toLowerCase();

  // --- команды пользователя ---
  switch (command) {
    case "/start":
      await user.handleStart(env, {
        id: message.from.id,
        username: message.from.username,
        first_name: message.from.first_name,
      });
      return;
    case "/key":
      if (existing) await user.handleKey(env, existing);
      else await sendMessage(env, message.chat.id, "Сначала зарегистрируйтесь: /start");
      return;
    case "/status":
      if (existing) await user.handleStatus(env, existing);
      else await sendMessage(env, message.chat.id, "Сначала зарегистрируйтесь: /start");
      return;
    case "/newkey":
      if (existing) await user.handleNewKey(env, existing);
      else await sendMessage(env, message.chat.id, "Сначала зарегистрируйтесь: /start");
      return;
    case "/help":
      await user.handleHelp(env, existing);
      return;
    default:
      break;
  }

  // Всё ниже — только админ. Остальным не отвечаем вовсе.
  if (!isAdmin) return;

  const reply = await runAdminCommand(env, command, args);
  if (reply) await sendMessage(env, message.chat.id, reply);
}

async function runAdminCommand(
  env: Env,
  command: string,
  args: string[],
): Promise<string | null> {
  const chat = chatOf(env);

  switch (command) {
    case "/users":
      await admin.cmdUsers(env);
      return null;
    case "/user":
      return args[0] ? await admin.cmdUser(env, args[0]) : "Формат: /user &lt;tg_id&gt;";
    case "/approve": {
      if (!args[0]) return "Формат: /approve &lt;tg_id&gt; [дней]";
      const days = Number(args[1] ?? "30");
      return await admin.cmdApprove(env, args[0], Number.isFinite(days) ? days : 30);
    }
    case "/ban":
      return args[0] ? await admin.cmdSetStatus(env, args[0], "status", "banned") : "Формат: /ban &lt;tg_id&gt;";
    case "/unban":
      return args[0] ? await admin.cmdSetStatus(env, args[0], "status", "active") : "Формат: /unban &lt;tg_id&gt;";
    case "/extend":
      return args[0] && args[1]
        ? await admin.cmdSetStatus(env, args[0], "extend", args[1])
        : "Формат: /extend &lt;tg_id&gt; &lt;дней&gt;";
    case "/limit":
      return args[0] && args[1]
        ? await admin.cmdSetStatus(env, args[0], "limit", args[1])
        : "Формат: /limit &lt;tg_id&gt; &lt;число&gt;";
    case "/pools":
      return await admin.cmdPools(env);
    case "/grant":
      return args[0] && args[1]
        ? await admin.cmdGrant(env, args[0], args[1])
        : "Формат: /grant &lt;tg_id&gt; &lt;пул&gt;";
    case "/revoke":
      return args[0] && args[1]
        ? await admin.cmdGrant(env, args[0], args[1], true)
        : "Формат: /revoke &lt;tg_id&gt; &lt;пул&gt;";
    case "/servers":
      return await admin.cmdServers(env);
    case "/rebalance":
      return await admin.cmdRebalance(env);
    case "/report":
      return await admin.cmdReport(env);
    case "/addsource":
      return args.length >= 3
        ? await admin.cmdAddSource(env, args[0], args[1], args.slice(2).join(" "))
        : "Формат: /addsource &lt;имя&gt; &lt;тип&gt; &lt;ссылка&gt;\nТипы: own_vps, trial, public, bridge_ru, cdn_xhttp, paid_private";
    case "/delsource":
      return args[0] ? await admin.cmdDelSource(env, Number(args[0])) : "Формат: /delsource &lt;id&gt;";
    case "/private":
      return args[0] ? await admin.cmdPrivate(env, Number(args[0])) : "Формат: /private &lt;id&gt;";
    case "/addkey":
      await env.CACHE.put(`state:addkey:${chat}`, "1", { expirationTtl: 900 });
      return "Пришлите следующим сообщением vless:// (можно несколько строк) или ссылку-подписку.";
    default:
      return null;
  }
}

async function handleCallback(
  env: Env,
  query: NonNullable<TgUpdate["callback_query"]>,
): Promise<void> {
  if (String(query.from.id) !== adminId(env)) {
    await answerCallback(env, query.id, "Недостаточно прав");
    return;
  }

  const data = query.data ?? "";
  const [action, ...rest] = data.split(":");

  const userRow = rest.length
    ? await one<UserRow>(
        env,
        "SELECT * FROM users WHERE id = ?",
        Number(action === "ap" ? rest[1] : rest[0]),
      )
    : null;

  if (action === "ap" && userRow) {
    const days = Number(rest[0]) || 30;
    const { approveUser } = await import("./user");
    await approveUser(env, userRow.id, days);
    await answerCallback(env, query.id, "Одобрено");
    if (query.message) {
      await sendMessage(
        env,
        query.message.chat.id,
        `Пользователь ${userRow.tg_id} одобрен на ${days} дн.`,
      );
    }
    return;
  }

  if (action === "rj" && userRow) {
    await answerCallback(env, query.id, "Отклонено");
    await env.DB.prepare("UPDATE users SET status='banned' WHERE id = ?")
      .bind(userRow.id)
      .run();
    await logEvent(env, "reject", userRow.id, "заявка отклонена");
    await sendMessage(env, userRow.tg_id, "Заявка отклонена администратором.");
    return;
  }

  await answerCallback(env, query.id, "Не понял команду");
}
