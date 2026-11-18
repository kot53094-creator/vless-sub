/** Роутер обновлений Telegram. Команды только из личных чатов. */

import { logEvent, many, one, run } from "../db";
import { memRateLimit } from "../security";
import type { Env, UserRow } from "../types";
import * as admin from "./admin";
import { answerCallback, adminId, sendMessage, sendToAdmin } from "./telegram";
import * as user from "./user";
import { rotateToken, setDeviceBlocked } from "../sub";
import { runSync } from "../sync";
import { parsePromoCommand } from "../promotions";
import { cmdMarkAlive, cmdMarkDead } from "./manual";
import { handleAiCommand } from "../ai";
import { paymentsText, recordMoneyPayment } from "../plans";
import {
  checkPayment,
  handleSuccessfulPayment,
  paySupportText,
  preCheckoutPayloadError,
  sendBuyMenu,
  sendMyOrders,
  sendPlanScreen,
  startPayment,
  type PreCheckoutQuery,
  type SuccessfulPayment,
} from "./buy";
import { answerPreCheckout } from "../pay/stars";
import { notifyPaid, refundOrder } from "../pay";
import { closeOrder, markOrderPaid } from "../orders";
import { createGift, listGifts, redeemGift } from "../gifts";
import { listTrafficPacks } from "../traffic_packs";
import { findOrder, revenue } from "../orders";
import { formatRub } from "../pay/money";

interface TgMessage {
  message_id: number;
  chat: { id: number; type: string };
  from?: { id: number; username?: string; first_name?: string };
  text?: string;
  /** Приходит только после реального списания звёзд. */
  successful_payment?: SuccessfulPayment;
}

export interface TgUpdate {
  message?: TgMessage;
  callback_query?: {
    id: string;
    data?: string;
    from: { id: number };
    message?: { chat: { id: number }; message_id: number };
  };
  /** Проверка перед списанием: подтвердить нужно за 10 секунд. */
  pre_checkout_query?: PreCheckoutQuery;
}

function chatOf(env: Env): string {
  return adminId(env);
}

const PROMO_STATE = (tgId: string) => `state:promo:${tgId}`;

export async function handleUpdate(env: Env, update: TgUpdate): Promise<void> {
  // Проверка перед списанием звёзд. Отвечаем всегда — и «да», и «нет»:
  // молчание здесь означает отменённый платёж и злого человека.
  if (update.pre_checkout_query) {
    const query = update.pre_checkout_query;
    const error = await preCheckoutPayloadError(env, query);
    await answerPreCheckout(env, query.id, !error, error ?? undefined);
    return;
  }

  if (update.callback_query) {
    await handleCallback(env, update.callback_query);
    return;
  }

  const message = update.message;
  if (!message || message.chat.type !== "private" || !message.from) return;

  const tgId = String(message.from.id);

  // Оплата подтверждена Telegram — только теперь можно выдавать дни.
  if (message.successful_payment) {
    await handleSuccessfulPayment(env, tgId, message.successful_payment);
    return;
  }
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
      // Ссылка «Продлить» из Mini App: t.me/<bot>?start=pay_<тариф>.
      if (existing && (args[0] ?? "").startsWith("pay_") && args[0] !== "pay_ok") {
        await sendPlanScreen(env, message.chat.id, (args[0] ?? "").slice(4));
        return;
      }
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
    case "/plans":
    case "/тарифы":
      await sendBuyMenu(env, message.chat.id);
      return;
    case "/buy":
    case "/купить":
    case "/подписка":
      await sendBuyMenu(env, message.chat.id);
      return;
    case "/orders":
    case "/покупки": {
      if (!existing) {
        await sendMessage(env, message.chat.id, "Сначала зарегистрируйтесь: /start");
        return;
      }
      await sendMyOrders(env, message.chat.id, existing);
      return;
    }
    case "/paysupport":
    case "/оплата":
      await sendMessage(env, message.chat.id, paySupportText(env));
      return;
    case "/topup":
    case "/трафик": {
      // Безлимитный тариф: докупать нечего, и продавать пакет «в никуда»
      // нельзя — поэтому честно говорим, что ограничения по объёму нет.
      const quota = existing?.traffic_gb ?? 0;
      if (!quota) {
        await sendMessage(
          env,
          message.chat.id,
          "📊 <b>Трафик без ограничений</b>\n\nНа вашем тарифе нет квоты по объёму — докупать нечего.\nДоступ закрывается только когда заканчивается срок подписки: /buy",
        );
        return;
      }
      const packs = await listTrafficPacks(env);
      const bot = String(env.BOT_USERNAME ?? "").replace(/^@/, "");
      if (!packs.length) {
        await sendMessage(env, message.chat.id, "Докупка трафика пока не настроена.");
        return;
      }
      const lines = [
        "<b>Докупить трафик</b>",
        "",
        ...packs.map((pack) => `• ${pack.title} — ${formatRub(pack.price_rub)}`),
        "",
        "Оплата — в кабинете: выберите пакет и способ оплаты.",
      ];
      await sendMessage(
        env,
        message.chat.id,
        lines.join("\n"),
        bot
          ? { inline_keyboard: [[{ text: "📊 Открыть кабинет", url: `https://t.me/${bot}?startapp` }]] }
          : undefined,
      );
      return;
    }
    case "/gift":
    case "/подарок": {
      // Подарочный код: дни без оплаты. Выдача — атомарная, повторная
      // активация того же кода отклоняется.
      if (!existing) {
        await sendMessage(env, message.chat.id, "Сначала /start");
        return;
      }
      const code = (args[0] ?? "").trim();
      if (!code) {
        await sendMessage(
          env,
          message.chat.id,
          "Формат: <code>/gift КОД</code>\nКод выглядит так: <code>AB12-CD34</code>",
        );
        return;
      }
      const redeemed = await redeemGift(env, code, {
        id: existing.id,
        tg_id: String(existing.tg_id),
      });
      if (!redeemed.ok) {
        await sendMessage(env, message.chat.id, `Не получилось: ${redeemed.error ?? "ошибка"}`);
        return;
      }
      const until = redeemed.expiresAt?.slice(0, 10) ?? "";
      await sendMessage(
        env,
        message.chat.id,
        `🎁 Код активирован: <b>+${redeemed.days} дн.</b>${until ? `\nДоступ до <b>${until}</b>.` : ""}`,
      );
      return;
    }
    case "/paid":
    case "/оплатил": {
      // Подтверждение перевода: человек нажал «оплатил» на странице оплаты
      // или просто написал команду. Админ получает заказ с двумя кнопками.
      if (!existing) {
        await sendMessage(env, message.chat.id, "Сначала /start");
        return;
      }
      const publicId = (args[0] ?? "").trim();
      if (!publicId) {
        await sendMessage(env, message.chat.id, "Формат: /paid ord_xxxx (номер есть на странице оплаты)");
        return;
      }
      const order = await findOrder(env, publicId);
      if (!order || order.user_id !== existing.id) {
        await sendMessage(env, message.chat.id, "Заказ не найден.");
        return;
      }
      if (order.status === "paid") {
        await sendMessage(env, message.chat.id, "Этот заказ уже оплачен.");
        return;
      }
      if (order.status !== "pending") {
        await sendMessage(env, message.chat.id, "Счёт больше не действует. Создайте новый: /buy");
        return;
      }
      await sendMessage(
        env,
        message.chat.id,
        `Заявка отправлена. Заказ <code>${order.public_id}</code> · ${formatRub(order.amount_rub)}\nПроверим перевод и включим доступ — обычно до 30 минут.`,
      );
      const adminChat = adminId(env);
      if (adminChat) {
        await sendMessage(
          env,
          adminChat,
          [
            `<b>Перевод на проверку</b>`,
            `${order.plan_title} · ${formatRub(order.amount_rub)} · ${order.days} дн.`,
            `Заказ <code>${order.public_id}</code>`,
            `Пользователь: ${existing.tg_username ? "@" + existing.tg_username : existing.tg_id}`,
          ].join("\n"),
          {
            inline_keyboard: [
              [
                { text: "✅ Подтвердить", callback_data: `ordok:${order.public_id}`.slice(0, 60) },
                { text: "✖️ Отклонить", callback_data: `ordno:${order.public_id}`.slice(0, 60) },
              ],
            ],
          },
        );
      }
      return;
    }
    case "/terms":
    case "/оферта": {
      const base = String(env.PUBLIC_BASE_URL ?? "").replace(/\/$/, "");
      await sendMessage(
        env,
        message.chat.id,
        [
          "<b>Документы</b>",
          base ? `Оферта: ${base}/legal/oferta` : "",
          base ? `Оплата и возврат: ${base}/legal/refund` : "",
          base ? `Конфиденциальность: ${base}/legal/privacy` : "",
        ]
          .filter(Boolean)
          .join("\n"),
      );
      return;
    }
    default:
      break;
  }

  // Всё ниже — только админ. Остальным не отвечаем вовсе.
  if (!isAdmin) return;

  // ИИ-админ: свободная фраза после /ai, подтверждение — «/ai да».
  // Разбираем до runAdminCommand: здесь запрос — произвольный текст,
  // а не набор аргументов команды.
  if (command === "/ai") {
    const query = text.replace(/^\/ai(@\S+)?\s*/i, "").trim();
    const aiReply = await handleAiCommand(env, tgId, query);
    if (aiReply) await sendMessage(env, message.chat.id, aiReply);
    return;
  }

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
    // Живая сводка по узлам: «что с серверами». Отвечает по базе, никаких
    // внешних сервисов и лимитов — в отличие от ИИ, который всё равно не
    // умеет проверять туннели.
    case "/servers":
    case "/серверы":
    case "/servers_status": {
      const rows = await many<{ status: string; n: number }>(
        env,
        "SELECT status, COUNT(*) AS n FROM servers WHERE enabled = 1 GROUP BY status",
      );
      const pool = await one<{ n: number }>(
        env,
        `SELECT COUNT(*) AS n FROM servers
          WHERE enabled = 1 AND verified_latency_ms > 0
            AND verified_at >= datetime('now','-24 hours')`,
      );
      const hour = await one<{ n: number; ok: number }>(
        env,
        `SELECT COUNT(*) AS n, SUM(CASE WHEN result = 'ok' THEN 1 ELSE 0 END) AS ok
           FROM server_checks WHERE checked_at >= datetime('now','-1 hour')`,
      );
      const countries = await many<{ country_code: string; n: number }>(
        env,
        `SELECT country_code, COUNT(*) AS n FROM servers
          WHERE enabled = 1 AND verified_latency_ms > 0
            AND verified_at >= datetime('now','-24 hours')
            AND country_code IS NOT NULL AND country_code <> ''
          GROUP BY country_code ORDER BY n DESC LIMIT 5`,
      );

      const byStatus = new Map(rows.map((r) => [r.status, Number(r.n)]));
      const total = [...byStatus.values()].reduce((a, b) => a + b, 0);
      const checked = Number(hour?.n ?? 0);
      const okCount = Number(hour?.ok ?? 0);
      const rate = checked > 0 ? Math.round((okCount / checked) * 100) : 0;
      const top = countries.length
        ? countries.map((c) => `${c.country_code} ${c.n}`).join(", ")
        : "нет данных";

      return [
        `Узлы: ${total}`,
        `живых ${byStatus.get("alive") ?? 0} · мёртвых ${byStatus.get("dead") ?? 0} · неясных ${byStatus.get("unknown") ?? 0}`,
        `В подписке сейчас: ${pool?.n ?? 0}`,
        `Проверено за час: ${checked}, прошло ${okCount} (${rate}%)`,
        `Страны в подписке: ${top}`,
      ].join("\n");
    }
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
    case "/dead":
      // «Этот сервер не работает» — самый точный сигнал: проверка идёт из
      // США, а человек сидит в России и видит реальный результат.
      return await cmdMarkDead(env, args.join(" ").trim());
    case "/alive":
      return await cmdMarkAlive(env, args.join(" ").trim());
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
    case "/pay": {
      const amount = Number(args[1] ?? "");
      if (!args[0] || !Number.isFinite(amount)) {
        return "Формат: /pay &lt;tg_id&gt; &lt;сумма&gt; [дней] [заметка]";
      }
      const days = args[2] === undefined ? undefined : Number(args[2]);
      if (days !== undefined && !Number.isFinite(days)) {
        return "Дней должно быть числом.";
      }
      const result = await recordMoneyPayment(env, {
        tgId: args[0],
        amountRub: amount,
        days,
        note: args.slice(3).join(" "),
        actor: `tg:${chat}`,
      });
      return result.message;
    }
    case "/payments":
      return await paymentsText(env, Number(args[0] ?? "10") || 10);
    case "/revenue":
    case "/выручка": {
      const report = await revenue(env);
      const line = (label: string, item: { count: number; sum: number }) =>
        `${label}: ${formatRub(item.sum)} · ${item.count} оплат`;
      return [
        "<b>Выручка</b>",
        line("Сегодня", report.today),
        line("7 дней", report.week),
        line("30 дней", report.month),
        line("Всего", report.total),
        `Возвраты: ${formatRub(report.refunded.sum)} · ${report.refunded.count}`,
        "",
        `Активных подписок: ${report.activeSubs}`,
        `Неоплаченных счетов: ${report.pending}`,
      ].join("\n");
    }
    case "/order": {
      if (!args[0]) return "Формат: /order <ord_…|id>";
      const order = await findOrder(env, args[0]);
      if (!order) return "Заказ не найден.";
      return [
        `<b>${order.public_id}</b>`,
        `${order.plan_title} · ${formatRub(order.amount_rub)} · ${order.days} дн.`,
        `Способ: ${order.provider} · статус: ${order.status}`,
        `Создан: ${order.created_at}`,
        `Оплачен: ${order.paid_at ?? "—"}`,
        order.external_id ? `Платёж: <code>${order.external_id}</code>` : "",
        order.telegram_charge_id ? `Charge: <code>${order.telegram_charge_id}</code>` : "",
      ]
        .filter(Boolean)
        .join("\n");
    }
    case "/refund": {
      if (!args[0]) return "Формат: /refund <ord_…|id> [manual]";
      const order = await findOrder(env, args[0]);
      if (!order) return "Заказ не найден.";
      const outcome = await refundOrder(env, order, { manual: args[1] === "manual" });
      return outcome.message;
    }
    case "/giftnew": {
      // /giftnew 30 5 — пять кодов по 30 дней, срок жизни кода 30 дней.
      const days = Number(args[0] ?? "0");
      if (!Number.isFinite(days) || days <= 0) {
        return "Формат: /giftnew <дней> [сколько кодов] [срок жизни кода в днях]";
      }
      const count = Number(args[1] ?? "1") || 1;
      const validDays = Number(args[2] ?? "30") || 30;
      const created = await createGift(env, days, { count, validDays });
      if (!created.length) return "Не удалось создать коды: проверьте, применена ли миграция 0024.";
      return [
        `<b>Создано кодов: ${created.length}</b> · ${days} дн.`,
        "",
        ...created.map((gift) => `<code>${gift.code}</code>`),
        "",
        "Активация у пользователя: /gift КОД",
      ].join("\n");
    }
    case "/gifts": {
      const list = await listGifts(env, 15);
      if (!list.length) return "Кодов пока нет. Создать: /giftnew 30 5";
      return [
        "<b>Последние коды</b>",
        "",
        ...list.map((gift) => {
          const state = gift.redeemed_by ? `активирован ${gift.redeemed_at?.slice(0, 10)}` : "свободен";
          return `<code>${gift.code}</code> · ${gift.days} дн. · ${state}`;
        }),
      ].join("\n");
    }
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
    // Раньше это был второй `case "/servers"` — недостижимая ветка: команда
    // всегда попадала в сводку выше, а список серверов нельзя было получить
    // вообще. Разводим по разным командам, чтобы работали обе.
    case "/servers_list":
    case "/узлы":
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
    data.startsWith("srv:") ||
    data.startsWith("chk:") ||
    data.startsWith("pay:")
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
      await answerCallback(env, query.id, "");
      await sendBuyMenu(env, chatId);
      return;
    }

    // ── касса ──────────────────────────────────────────────────────────
    // Подтверждение перевода — только владелец бота.
    if (data.startsWith("ordok:") || data.startsWith("ordno:")) {
      if (String(tgId) !== String(adminId(env))) {
        await answerCallback(env, query.id, "Нет доступа", true);
        return;
      }
      const publicId = data.slice("ordok:".length);
      const approve = data.startsWith("ordok:");
      const order = await findOrder(env, publicId);
      if (!order) {
        await answerCallback(env, query.id, "Заказ не найден", true);
        return;
      }
      if (!approve) {
        await closeOrder(env, publicId, "canceled", "перевод не подтверждён");
        await answerCallback(env, query.id, "Отклонено");
        const { one } = await import("../db");
        const row = await one<{ tg_id: string }>(
          env,
          "SELECT tg_id FROM users WHERE id = ?",
          order.user_id,
        );
        if (row?.tg_id) {
          await sendMessage(
            env,
            row.tg_id,
            [
              "<b>Перевод не найден</b>",
              `Заказ <code>${order.public_id}</code> отменён.`,
              "Если деньги списались — напишите /paysupport, разберёмся вручную.",
            ].join("\n"),
          );
        }
        return;
      }
      const result = await markOrderPaid(env, publicId, {
        externalId: `transfer:${publicId}`,
        currency: "RUB",
        amountMinor: order.amount_rub * 100,
        providerChargeId: `transfer:${publicId}`,
        orderPublicId: publicId,
      });
      await answerCallback(env, query.id, result.ok ? "Оплата зачислена" : "Не удалось");
      if (result.ok) {
        const { one } = await import("../db");
        const row = await one<{ tg_id: string }>(
          env,
          "SELECT tg_id FROM users WHERE id = ?",
          order.user_id,
        );
        if (row?.tg_id) await notifyPaid(env, result, row.tg_id);
      }
      return;
    }

    if (data === "pay:menu") {
      await answerCallback(env, query.id, "");
      await sendBuyMenu(env, chatId);
      return;
    }
    if (data.startsWith("pay:plan:")) {
      await answerCallback(env, query.id, "");
      await sendPlanScreen(env, chatId, data.slice("pay:plan:".length));
      return;
    }
    if (data.startsWith("pay:check:")) {
      if (!existing) {
        await answerCallback(env, query.id, "Сначала нажмите /start.", true);
        return;
      }
      await answerCallback(env, query.id, "Проверяю оплату…");
      await checkPayment(env, chatId, existing, data.slice("pay:check:".length));
      return;
    }
    if (
      data.startsWith("pay:stars:") ||
      data.startsWith("pay:crypto:") ||
      data.startsWith("pay:card:")
    ) {
      if (!existing) {
        await answerCallback(env, query.id, "Сначала нажмите /start.", true);
        return;
      }
      if (!memRateLimit(`pay:${tgId}`, 8, 60)) {
        await answerCallback(env, query.id, "Не так быстро — счёт уже создан.", true);
        return;
      }
      const [, prefix, ...rest] = data.split(":");
      await answerCallback(env, query.id, "Готовлю счёт…");
      await startPayment(env, chatId, existing, prefix ?? "", rest.join(":"));
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

    if (data === "srv:list" || data.startsWith("srv:")) {
      if (!existing || existing.status !== "active") {
        await answerCallback(env, query.id, "Доступ ещё не активен.", true);
        return;
      }
      if (data === "srv:auto") {
        await user.setPreferredServer(env, existing, null);
        await answerCallback(env, query.id, "Выбор снят: сортировка по скорости");
      } else if (data !== "srv:list") {
        const serverId = Number(data.slice(4));
        if (!Number.isFinite(serverId) || serverId <= 0) {
          await answerCallback(env, query.id, "Не понял, какой сервер", true);
          return;
        }
        await user.setPreferredServer(env, existing, serverId);
        await answerCallback(env, query.id, "Сервер выбран, он будет первым");
      } else {
        await answerCallback(env, query.id, "");
      }
      const fresh = await user.findUser(env, tgId);
      if (fresh) await user.sendServerPicker(env, chatId, fresh, messageId);
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
    await run(env, "UPDATE users SET status='banned' WHERE id = ?", userRow.id);
    await logEvent(env, "reject", userRow.id, "заявка отклонена");
    await sendMessage(env, userRow.tg_id, "Заявка отклонена администратором.");
    return;
  }

  await answerCallback(env, query.id, "Не понял команду");
}
