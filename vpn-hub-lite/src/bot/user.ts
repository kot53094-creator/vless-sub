/** Команды обычного пользователя. */

import { assignForUser, assignmentCount } from "../balance";
import { daysFromNowIso, logEvent, many, one, run } from "../db";
import { devices24h, invalidateSubscription, rotateToken } from "../sub";
import { randomToken } from "../security";
import type { Env, UserRow } from "../types";
import { escapeHtml, sendMessage, sendToAdmin } from "./telegram";
import {
  BRAND,
  DEVICES,
  HELP,
  INSTRUCTIONS,
  WELCOME,
  backKeyboard,
  deviceKeyboard,
  mainKeyboard,
} from "./texts";

export interface TgFrom {
  id: number;
  username?: string;
  first_name?: string;
}

export function linkFor(env: Env, token: string): string {
  return `${env.PUBLIC_BASE_URL.replace(/\/$/, "")}/sub/${token}`;
}

function maxUsers(env: Env): number {
  return Number(env.MAX_USERS ?? "50") || 50;
}

function serversPerUser(env: Env): number {
  return Math.max(1, Number(env.SERVERS_PER_USER ?? "3") || 3);
}

export function howToConnect(): string {
  return [
    "<b>Как подключить</b>",
    "1. Установите Happ (Android, iOS, Windows, macOS).",
    "2. Нажмите «+» → «Импорт по ссылке» / «Add subscription».",
    "3. Вставьте ссылку, которую пришлёт бот, и сохраните.",
    "4. Выберите любой сервер из списка и включите VPN.",
    "",
    "Подписка обновляется сама: Happ перечитывает её раз в 6 часов.",
    "Если сервер не работает — потяните список вниз для обновления:",
    "хаб сам заменяет мёртвые ноды.",
  ].join("\n");
}

export async function findUser(env: Env, tgId: string): Promise<UserRow | null> {
  return await one<UserRow>(env, "SELECT * FROM users WHERE tg_id = ?", tgId);
}

function expiryNote(user: UserRow): string {
  if (!user.expires_at) return "без срока";
  const ts = Date.parse(user.expires_at.replace(" ", "T") + "Z");
  const days = Math.ceil((ts - Date.now()) / 86400_000);
  if (!Number.isFinite(days)) return "без срока";
  if (days < 0) return "срок истёк";
  return days === 0 ? "истекает сегодня" : `осталось ${days} дн.`;
}

export async function handleStart(env: Env, from: TgFrom): Promise<void> {
  const tgId = String(from.id);
  const existing = await findUser(env, tgId);

  if (existing) {
    if (existing.status === "banned") {
      await sendMessage(env, tgId, "Доступ закрыт. Напишите администратору.");
      return;
    }
    if (existing.status === "active") {
      await sendMenu(env, tgId);
      await sendMessage(
        env,
        tgId,
        `Вы уже подключены (${expiryNote(existing)}). Ссылка — в «👤 Кабинете».`,
      );
      return;
    }
    if (existing.status === "pending") {
      await sendMessage(env, tgId, "Заявка уже отправлена админу. Подождите ответа.");
      return;
    }
    await sendMessage(env, tgId, "Срок истёк. Напишите администратору, чтобы продлить.");
    return;
  }

  const total = await one<{ n: number }>(
    env,
    "SELECT COUNT(*) AS n FROM users WHERE status IN ('pending', 'active')",
  );
  if ((total?.n ?? 0) >= maxUsers(env)) {
    await sendMessage(env, tgId, "Свободных мест нет. Напишите администратору позже.");
    await sendToAdmin(env, `Отказ в регистрации: достигнут лимит ${maxUsers(env)} пользователей.`);
    return;
  }

  const token = randomToken(32);
  const result = await run(
    env,
    `INSERT INTO users (tg_id, tg_username, status, sub_token, device_limit)
     VALUES (?, ?, 'pending', ?, 2)`,
    tgId,
    (from.username ?? "").slice(0, 64),
    token,
  );
  const userId = Number(result.meta.last_row_id ?? 0);

  await logEvent(env, "register", userId, "заявка на регистрацию");
  await sendMessage(env, tgId, WELCOME, mainKeyboard());
  await sendMessage(
    env,
    tgId,
    "Заявка отправлена админу. Как только её одобрят, пришлю вашу ссылку для Happ.",
  );

  const name = escapeHtml(from.username ? `@${from.username}` : `id ${tgId}`);
  await sendMessage(
    env,
    String(env.ADMIN_TG_ID ?? "8938447065"),
    `<b>Новая заявка</b>\n${name}\nВсего пользователей: ${(total?.n ?? 0) + 1}`,
    {
      inline_keyboard: [
        [
          { text: "Одобрить 7 дней", callback_data: `ap:7:${userId}` },
          { text: "Одобрить 30 дней", callback_data: `ap:30:${userId}` },
        ],
        [{ text: "Отклонить", callback_data: `rj:${userId}` }],
      ],
    },
  );
}

export async function approveUser(
  env: Env,
  userId: number,
  days: number,
): Promise<UserRow | null> {
  const user = await one<UserRow>(env, "SELECT * FROM users WHERE id = ?", userId);
  if (!user) return null;

  const expires = daysFromNowIso(days);
  await run(
    env,
    "UPDATE users SET status='active', expires_at=? WHERE id=?",
    expires,
    userId,
  );

  // Пулы: если админ не назначил ни одного — выдаём все.
  const pools = await one<{ n: number }>(
    env,
    "SELECT COUNT(*) AS n FROM user_pools WHERE user_id = ?",
    userId,
  );
  if (!pools?.n) {
    await run(
      env,
      "INSERT OR IGNORE INTO user_pools (user_id, pool_id) SELECT ?, id FROM pools",
      userId,
    );
  }

  const assigned = await assignForUser(env, userId, serversPerUser(env));
  await invalidateSubscription(env, user.sub_token);
  await logEvent(
    env,
    "approve",
    userId,
    `одобрен на ${days} дн., серверов: ${assigned.length}`,
  );

  const link = linkFor(env, user.sub_token);
  const served = assigned.length
    ? `Серверов выдано: ${assigned.length}.`
    : "Свободных серверов нет — админ добавит их в ближайшее время.";

  await sendMessage(
    env,
    user.tg_id,
    [
      "<b>Доступ открыт</b>",
      `Срок: ${expires.slice(0, 10)} (${days} дн.)`,
      served,
      "",
      `<code>${escapeHtml(link)}</code>`,
      "",
      howToConnect(),
    ].join("\n"),
  );

  if (!assigned.length) {
    await sendToAdmin(env, `У пользователя ${user.tg_id} нет серверов: все места заняты.`);
  }
  return user;
}

/** Главное меню — тот же экран, что на макете. */
export async function sendMenu(env: Env, chatId: number | string): Promise<void> {
  await sendMessage(env, chatId, WELCOME, mainKeyboard());
}

export async function sendDevices(env: Env, chatId: number | string): Promise<void> {
  await sendMessage(
    env,
    chatId,
    "<b>Включить VPN</b>\nВыберите устройство, на котором хотите пользоваться VPN:",
    deviceKeyboard(),
  );
}

export async function sendInstruction(
  env: Env,
  chatId: number | string,
  device: string,
): Promise<void> {
  const label = DEVICES.find((item) => item.key === device)?.label ?? device;
  await sendMessage(
    env,
    chatId,
    `<b>${label}</b>\n${INSTRUCTIONS[device] ?? INSTRUCTIONS.android}`,
    backKeyboard(),
  );
}

export async function sendCabinet(
  env: Env,
  chatId: number | string,
  user: UserRow | null,
): Promise<void> {
  if (!user) {
    await sendMessage(env, chatId, "Заявки пока нет. Нажмите /start.");
    return;
  }
  const until = user.expires_at ? user.expires_at.slice(0, 10) : "не задан";
  const status =
    user.status === "active"
      ? "активен"
      : user.status === "pending"
        ? "ждёт одобрения"
        : user.status === "banned"
          ? "закрыт"
          : "истёк";
  const link = linkFor(env, user.sub_token);
  const body =
    `<b>${BRAND} · кабинет</b>\n` +
    `Статус: ${status}\n` +
    `Доступ до: ${until}\n` +
    `Устройств: до ${user.device_limit}\n\n` +
    (user.status === "active"
      ? `<code>${escapeHtml(link)}</code>`
      : "Ссылка станет активной после одобрения.");

  await sendMessage(env, chatId, body, {
    inline_keyboard: [
      [{ text: "⚡️ Как подключить", callback_data: "act:devices" }],
      user.status === "active"
        ? [{ text: "♻️ Новая ссылка", callback_data: "act:newkey" }]
        : [],
      [{ text: "← В меню", callback_data: "act:menu" }],
    ].filter((row) => row.length > 0),
  });
}

export async function sendHelp(env: Env, chatId: number | string): Promise<void> {
  await sendMessage(env, chatId, HELP, mainKeyboard());
}

export async function handleKey(env: Env, user: UserRow): Promise<void> {
  if (user.status !== "active") {
    await sendMessage(env, user.tg_id, `Ссылка недоступна: ${user.status}.`);
    return;
  }
  await sendMessage(
    env,
    user.tg_id,
    `<b>Ваша ссылка</b>\n<code>${escapeHtml(linkFor(env, user.sub_token))}</code>`,
  );
}

export async function handleStatus(env: Env, user: UserRow): Promise<void> {
  const devices = await devices24h(env, user.id);
  const assigned = await assignmentCount(env, user.id);
  const pools = await many<{ name: string }>(
    env,
    `SELECT p.name FROM user_pools up JOIN pools p ON p.id = up.pool_id
     WHERE up.user_id = ? ORDER BY p.id`,
    user.id,
  );

  const lines = [
    `<b>Статус</b>`,
    `Доступ: ${user.status === "active" ? "активен" : user.status}`,
    `Срок: ${user.expires_at?.slice(0, 10) ?? "—"} (${expiryNote(user)})`,
    `Серверов выдано: ${assigned}`,
    `Устройств за 24 ч: ${devices} из ${user.device_limit}`,
    `Группы: ${pools.map((p) => escapeHtml(p.name)).join(", ") || "—"}`,
  ];

  if (devices > user.device_limit) {
    lines.push(
      "",
      "Внимание: устройств больше, чем разрешено. Отключите лишние — иначе доступ могут закрыть.",
    );
  } else if (devices === user.device_limit) {
    lines.push("", "Вы на пределе лимита устройств: новое устройство может не подключиться.");
  }

  await sendMessage(env, user.tg_id, lines.join("\n"));
}

export async function handleNewKey(env: Env, user: UserRow): Promise<void> {
  if (user.status !== "active") {
    await sendMessage(env, user.tg_id, "Перевыпуск доступен только активным пользователям.");
    return;
  }
  const token = await rotateToken(env, user);
  await sendMessage(
    env,
    user.tg_id,
    [
      "<b>Ссылка перевыпущена</b>",
      "Старая больше не работает.",
      `<code>${escapeHtml(linkFor(env, token))}</code>`,
      "",
      "В Happ удалите старую подписку и добавьте эту.",
    ].join("\n"),
  );
}

export async function handleHelp(env: Env, user: UserRow | null): Promise<void> {
  const chat = user?.tg_id;
  if (!chat) return;
  await sendMessage(
    env,
    chat,
    [
      howToConnect(),
      "",
      "<b>Команды</b>",
      "/key — моя ссылка",
      "/status — срок и устройства",
      "/newkey — перевыпустить ссылку",
      "/help — эта справка",
      "",
      "Если ничего не работает — напишите админу, он проверит серверы.",
    ].join("\n"),
  );
}
