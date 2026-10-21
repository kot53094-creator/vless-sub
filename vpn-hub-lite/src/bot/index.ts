/** Роутер обновлений Telegram. Команды только из личных чатов. */

import { logEvent, one } from "../db";
import { memRateLimit } from "../security";
import type { Env, UserRow } from "../types";
import * as admin from "./admin";
import { answerCallback, adminId, sendMessage } from "./telegram";
import * as user from "./user";
import { rotateToken, setDeviceBlocked } from "../sub";
import { runSync } from "../sync";
import { parsePromoCommand } from "../promotions";

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
    message?: { chat: { id: number }; message_id: number };
  };
}

function chatOf(env: Env): string {
  return adminId(env);
}

const PROMO_STATE = (tgId: string) => `state:promo:${tgId}`;

export async function handleUpdate(env: Env, update: TgUpdate): Promise<void> {
  if (update.callback_query) {
    await handleCallback(env, update.callback_query);
    return;
  }

  const message = update.message;
  if (!message || message.chat.type !== "private" || !message.from) return;

  const tgId = String(message.from.id);
  // анти-спам: 20 действий в минуту с одного аккаунта
  if (!memRateLimit(`tg:${tgId}`, 20, 60)) return;

  const text = (message.text ?? "").trim();
  if (!text) return;

  const isAdmin = tgId === adminId(env);
  const existing = await user.findUser(env, tgId);

  if (!text.startsWith("/")) {
    // Ждём промокод?
    if (await env.CACHE.get(PROMO_STATE(tgId))) {
      await env.CACHE.delete(PROMO_STATE(tgId));
      if (!existing) {
        await sendMessage(env, message.chat.id, "Сначала нажмите /start.");
        return;
      }
      const reply = await user.handlePromoCode(env, existing, text);
      await sendMessage(env, message.chat.id, reply);
      return;
    }
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
      await user.handleStart(
        env,
        {
          id: message.from.id,
          username: message.from.username,
          first_name: message.from.first_name,
        },
        args[0] ?? "",
      );
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
    case "/bonus": {
      if (!existing) {
        await sendMessage(env, message.chat.id, "Сначала зарегистрируйтесь: /start");
        return;
      }
      if (!memRateLimit(`bon:${tgId}`, 6, 60)) {
        await sendMessage(env, message.chat.id, "Не так быстро 🙂");
        return;
      }
      const reply = await user.claimBonusText(env, existing);
      await sendMessage(env, message.chat.id, reply);
      const fresh = await user.findUser(env, tgId);
      await user.sendCabinet(env, message.chat.id, fresh);
      return;
    }
    case "/ref":
    case "/referral": {
      if (!existing) {
        await sendMessage(env, message.chat.id, "Сначала нажмите /start.");
        return;
      }
      await user.sendReferral(env, message.chat.id, existing);
      return;
    }
    case "/promo": {
      if (!existing) {
        await sendMessage(env, message.chat.id, "Сначала нажмите /start.");
        return;
      }
      const code = parsePromoCommand(text);
      if (!code) {
        await env.CACHE.put(PROMO_STATE(tgId), "1", { expirationTtl: 600 });
        await sendMessage(env, message.chat.id, "Пришлите промокод одним сообщением.");
        return;
      }
      const reply = await user.handlePromoCode(env, existing, code);
      await sendMessage(env, message.chat.id, reply);
      return;
    }
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

/* ── кнопки ────────────────────────────────────────────────────────────── */

async function handleCallback(
  env: Env,
  query: NonNullable<TgUpdate["callback_query"]>,
): Promise<void> {
  const data = query.data ?? "";
  const chatId = query.message?.chat.id ?? query.from.id;
  const messageId = query.message?.message_id;
  const tgId = String(query.from.id);
  const isAdmin = tgId === adminId(env);

  // ── кнопки обычного пользователя: доступны всем ──
  if (
    data.startsWith("act:") ||
    data.startsWith("dev:") ||
    data.startsWith("dvb:") ||
    data.startsWith("dvu:") ||
    data.startsWith("bon:") ||
    data.startsWith("ref:") ||
    data.startsWith("prm:") ||
    data.startsWith("sq:") ||
    data.startsWith("chk:")
  ) {
    const existing = await one<UserRow>(env, "SELECT * FROM users WHERE tg_id = ?", tgId);

    if (data === "act:menu") {
      await answerCallback(env, query.id, "");
      await user.sendMenu(env, chatId, messageId);
      return;
    }
    if (data === "act:devices") {
      await answerCallback(env, query.id, "");
      await user.sendDevices(env, chatId, messageId);
      return;
    }
    if (data.startsWith("dvb:") || data.startsWith("dvu:")) {
      if (!existing) {
        await answerCallback(env, query.id, "Сначала нажмите /start.", true);
        return;
      }
      const deviceId = Number(data.slice(4));
      const block = data.startsWith("dvb:");
      if (!Number.isFinite(deviceId) || !memRateLimit(`dev:${tgId}`, 12, 60)) {
        await answerCallback(env, query.id, "Не так быстро", true);
        return;
      }
      const done = await setDeviceBlocked(env, existing.id, deviceId, block);
      await answerCallback(
        env,
        query.id,
        done ? (block ? "Устройство отвязано" : "Устройство возвращено") : "Устройство не найдено",
        !done,
      );
      await user.sendDevicesInfo(env, chatId, existing, messageId);
      return;
    }

    if (data === "dev:kick") {
      if (!existing || existing.status !== "active") {
        await answerCallback(env, query.id, "Доступ ещё не активен.", true);
        return;
      }
      await answerCallback(env, query.id, "");
      await user.confirmKickDevices(env, chatId, existing, messageId);
      return;
    }

    if (data === "dev:kick_yes") {
      if (!existing || existing.status !== "active") {
        await answerCallback(env, query.id, "Доступ ещё не активен.", true);
        return;
      }
      if (!memRateLimit(`kick:${tgId}`, 2, 300)) {
        await answerCallback(env, query.id, "Уже отключили. Подождите пару минут.", true);
        return;
      }
      await answerCallback(env, query.id, "Отключаю…");
      await user.kickDevices(env, chatId, existing, messageId);
      return;
    }

    if (data.startsWith("dev:")) {
      await answerCallback(env, query.id, "");
      await user.sendInstruction(env, chatId, data.slice(4), messageId);
      return;
    }
    if (data === "act:cabinet") {
      await answerCallback(env, query.id, "");
      await user.sendCabinet(env, chatId, existing, messageId);
      return;
    }
    if (data === "act:help") {
      await answerCallback(env, query.id, "");
      await user.sendHelp(env, chatId, messageId);
      return;
    }
    if (data === "act:term" || data === "act:traffic" || data === "act:devs") {
      if (!existing) {
        await answerCallback(env, query.id, "Сначала нажмите /start.", true);
        return;
      }
      await answerCallback(env, query.id, "");
      if (data === "act:term") await user.sendTerm(env, chatId, existing, messageId);
      else if (data === "act:traffic") await user.sendTraffic(env, chatId, existing, messageId);
      else await user.sendDevicesInfo(env, chatId, existing, messageId);
      return;
    }
    if (data === "act:plans") {
      await answerCallback(env, query.id, "Тарифы — у администратора.", true);
      return;
    }

    if (data === "bon:claim") {
      if (!existing) {
        await answerCallback(env, query.id, "Сначала нажмите /start.", true);
        return;
      }
      if (!memRateLimit(`bon:${tgId}`, 6, 60)) {
        await answerCallback(env, query.id, "Не так быстро 🙂", true);
        return;
      }
      const text = await user.claimBonusText(env, existing);
      await answerCallback(env, query.id, text, true);
      const fresh = await user.findUser(env, tgId);
      await user.sendCabinet(env, chatId, fresh, messageId);
      return;
    }

    if (data === "ref:show") {
      if (!existing) {
        await answerCallback(env, query.id, "Сначала нажмите /start.", true);
        return;
      }
      await answerCallback(env, query.id, "");
      await user.sendReferral(env, chatId, existing, messageId);
      return;
    }

    if (data === "prm:enter") {
      if (!existing) {
        await answerCallback(env, query.id, "Сначала нажмите /start.", true);
        return;
      }
      await env.CACHE.put(PROMO_STATE(tgId), "1", { expirationTtl: 600 });
      await answerCallback(env, query.id, "Пришлите промокод одним сообщением.", true);
      return;
    }

    if (data === "sq:bypass") {
      if (!existing) {
        await answerCallback(env, query.id, "Сначала нажмите /start.", true);
        return;
      }
      const result = await user.handleBypass(env, existing);
      await answerCallback(env, query.id, result.text, true);
      if (result.changed) {
        const fresh = await user.findUser(env, tgId);
        await user.sendCabinet(env, chatId, fresh, messageId);
      }
      return;
    }

    if (data === "chk:sub") {
      if (!existing) {
        await answerCallback(env, query.id, "Сначала нажмите /start.", true);
        return;
      }
      const result = await user.checkChannel(env, existing);
      await answerCallback(env, query.id, result.text, !result.ok);
      if (result.ok) {
        const fresh = await user.findUser(env, tgId);
        await user.sendCabinet(env, chatId, fresh);
      }
      return;
    }

    if (data === "act:status") {
      if (!existing) {
        await answerCallback(env, query.id, "Сначала нажмите /start.", true);
        return;
      }
      await answerCallback(env, query.id, "");
      await user.handleStatus(env, existing, messageId);
      return;
    }

    if (data === "act:refresh") {
      if (!isAdmin) {
        await answerCallback(env, query.id, "Обновлять может только администратор.", true);
        return;
      }
      await answerCallback(env, query.id, "Обновляю…");
      await sendMessage(env, chatId, "Обновляю. Напишу, когда закончу.");
      void runSync(env).catch(() => {});
      return;
    }

    if (data === "act:newkey") {
      if (!existing || existing.status !== "active") {
        await answerCallback(env, query.id, "Ссылка станет активной после одобрения.", true);
        return;
      }
      await answerCallback(env, query.id, "");
      const token = await rotateToken(env, existing);
      await sendMessage(
        env,
        chatId,
        `<b>Новая ссылка</b>\n<code>${user.linkFor(env, token)}</code>\n\nСтарая больше не работает.`,
      );
      return;
    }

    await answerCallback(env, query.id, "");
    return;
  }

  // ── дальше только админ ──
  if (!isAdmin) {
    await answerCallback(env, query.id, "Недостаточно прав", true);
    return;
  }

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
