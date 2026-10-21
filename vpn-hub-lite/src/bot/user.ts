/** Команды обычного пользователя. */

import { assignForUser, assignmentCount } from "../balance";
import { daysFromNowIso, logEvent, many, one, run } from "../db";
import {
  devices24h,
  invalidateSubscription,
  listDevices,
  rotateToken,
  setDeviceBlocked,
} from "../sub";
import { randomToken } from "../security";
import type { Env, UserRow } from "../types";
import { escapeHtml, sendMessage, sendToAdmin, type ReplyMarkup } from "./telegram";
import {
  BRAND,
  HELP,
  DEVICES,
  INSTRUCTIONS,
  WELCOME,
  activatedKeyboard,
  backKeyboard,
  cabinetKeyboard,
  channelKeyboard,
  deviceKeyboard,
  mainKeyboard,
  referralKeyboard,
} from "./texts";
import { editBanner, sendBanner } from "../banners";
import {
  attachReferral,
  channelId,
  claimChannel,
  claimDaily,
  dailyStatus,
  flag,
  grantSquad,
  loadSettings,
  nextMskMidnight,
  num,
  redeemPromo,
  referralStats,
  rewardReferral,
  revokeSquad,
  squadsOf,
} from "../bonus";
import { redeemInvite } from "../invites";
import { humanDuration, mskDate, plural, round2 } from "../promotions";

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

/* ── экраны ────────────────────────────────────────────────────────────── */

async function screen(
  env: Env,
  chatId: number | string,
  messageId: number | undefined,
  key: "start" | "trial" | "channel" | "devices" | "account" | "activated" | "expiring",
  caption: string,
  keyboard: ReplyMarkup,
): Promise<void> {
  if (messageId && (await editBanner(env, chatId, messageId, key, caption, keyboard))) return;
  await sendBanner(env, chatId, key, caption, keyboard);
}

export async function handleStart(
  env: Env,
  from: TgFrom,
  payload = "",
): Promise<void> {
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
      await sendChannelGate(env, tgId, true);
      return;
    }
    await sendMessage(env, tgId, "Срок истёк. Заберите бонус дня или напишите администратору.");
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

  if (payload && userId && !payload.startsWith("inv_")) {
    await attachReferral(env, userId, payload);
  }

  // Инвайт: подписка выдаётся сразу, без ожидания одобрения.
  if (payload.startsWith("inv_") && userId) {
    const terms = await redeemInvite(env, payload.slice(4), userId);
    if (terms) {
      await approveUser(env, userId, terms.days, { gb: terms.gb, devices: terms.devices });
      return;
    }
    await sendMessage(env, tgId, "Ссылка-приглашение недействительна или уже использована.");
    return;
  }

  await sendChannelGate(env, tgId, false);

  const name = escapeHtml(from.username ? `@${from.username}` : `id ${tgId}`);
  await sendMessage(
    env,
    String(env.ADMIN_TG_ID ?? "5680608085"),
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

/** Экран «подпишитесь на канал» — баннер 3. */
export async function sendChannelGate(
  env: Env,
  chatId: number | string,
  withMenu: boolean,
): Promise<void> {
  const channel = channelId(env);
  if (!channel) {
    await sendMessage(
      env,
      chatId,
      "Заявка отправлена админу. Как только её одобрят, пришлю вашу ссылку для Happ.",
      withMenu ? mainKeyboard({ referral: true }) : undefined,
    );
    return;
  }

  // Канал может быть @username или -100…; для ссылки нужен username.
  const url = /^-?\d+$/.test(channel)
    ? `https://t.me/c/${channel.replace(/^-100/, "")}`
    : `https://t.me/${channel.replace(/^@/, "")}`;
  const caption =
    `<b>Один шаг до подписки</b>\n` +
    `Подпишитесь на канал и нажмите «Проверить» — начислим день доступа.\n\n` +
    `Заявка уже у администратора.`;
  await sendBanner(env, chatId, "channel", caption, channelKeyboard(url));
}

export async function approveUser(
  env: Env,
  userId: number,
  days: number,
  terms: { gb?: number; devices?: number } = {},
): Promise<UserRow | null> {
  const user = await one<UserRow>(env, "SELECT * FROM users WHERE id = ?", userId);
  if (!user) return null;

  const firstTime = user.status !== "active";
  const expires = daysFromNowIso(days);
  await run(
    env,
    "UPDATE users SET status='active', expires_at=?, traffic_gb=?, device_limit=? WHERE id=?",
    expires,
    terms.gb ?? user.traffic_gb,
    terms.devices ?? user.device_limit,
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

  // Реферальная награда — только в момент первой активации.
  if (firstTime) await rewardReferral(env, userId);

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

  // Первая выдача доступа на срок до недели — это пробный период: свой баннер.
  const isTrial = firstTime && days <= 7;
  const caption = [
    isTrial ? `<b>Пробная подписка активирована!</b>` : `<b>Подписка активирована!</b>`,
    `Срок: ${expires.slice(0, 10)} (${days} дн.)`,
    served,
    "",
    `<code>${escapeHtml(link)}</code>`,
    "",
    "Скопируйте ссылку и добавьте её в Happ.",
  ].join("\n");

  await sendBanner(
    env,
    user.tg_id,
    isTrial ? "trial" : firstTime ? "activated" : "account",
    caption,
    firstTime ? activatedKeyboard() : cabinetKeyboard({ referral: true, promo: true, active: true }),
  );

  if (!assigned.length) {
    await sendToAdmin(env, `У пользователя ${user.tg_id} нет серверов: все места заняты.`);
  }
  return user;
}

/** Главное меню — баннер 1 и тот же набор кнопок, что на макете. */
export async function sendMenu(
  env: Env,
  chatId: number | string,
  messageId?: number,
): Promise<void> {
  const settings = await loadSettings(env);
  const options = {
    daily: flag(settings, "daily_enabled", true),
    referral: flag(settings, "referral_enabled", true),
    promo: flag(settings, "promo_enabled", true),
  };
  await screen(env, chatId, messageId, "start", WELCOME, mainKeyboard(options));
}

export async function sendDevices(
  env: Env,
  chatId: number | string,
  messageId?: number,
): Promise<void> {
  await screen(
    env,
    chatId,
    messageId,
    "devices",
    "<b>Включить VPN</b>\nВыберите устройство, на котором хотите пользоваться VPN:",
    deviceKeyboard(),
  );
}

export async function sendInstruction(
  env: Env,
  chatId: number | string,
  device: string,
  messageId?: number,
): Promise<void> {
  const label = DEVICES.find((item) => item.key === device)?.label ?? device;
  // Инструкция остаётся на том же баннере с устройствами: фото не скачет.
  await screen(
    env,
    chatId,
    messageId,
    "devices",
    `<b>${label}</b>\n${INSTRUCTIONS[device] ?? INSTRUCTIONS.android}`,
    {
      inline_keyboard: [
        [{ text: "← К устройствам", callback_data: "act:devices" }],
        [{ text: "👤 Кабинет", callback_data: "act:cabinet" }],
      ],
    },
  );
}

export async function cabinetBody(env: Env, user: UserRow): Promise<string> {
  const settings = await loadSettings(env);
  const until = user.expires_at ? user.expires_at.slice(0, 10) : "не задан";
  const status =
    user.status === "active"
      ? "активен"
      : user.status === "pending"
        ? "ждёт одобрения"
        : user.status === "banned"
          ? "закрыт"
          : "истёк";

  const lines = [
    `<b>${BRAND} · кабинет</b>`,
    `Статус: ${status}`,
    `Доступ до: ${until} · ${expiryNote(user)}`,
    `Устройств: до ${user.device_limit}`,
    `Трафик: ${user.traffic_gb ? `${user.traffic_gb} ГБ` : "без лимита"}`,
  ];

  if (flag(settings, "daily_enabled", true)) {
    const daily = await dailyStatus(env, user);
    const capText = `${round2(daily.usedHours)} из ${daily.capHours} ч`;
    lines.push(
      "",
      `<b>Бонус дня</b>`,
      daily.claimedToday
        ? `Серия: ${daily.streak} ${plural(daily.streak, "день", "дня", "дней")} · сегодня получен`
        : `Серия: ${daily.streak} ${plural(daily.streak, "день", "дня", "дней")} · бонус доступен`,
      `За месяц: ${capText}`,
    );
  }

  if (flag(settings, "referral_enabled", true)) {
    const refs = await referralStats(env, user.id);
    lines.push(
      "",
      `<b>Друзья</b>: ${refs.invited} ${plural(refs.invited, "приглашение", "приглашения", "приглашений")}` +
        ` · награда ${humanDuration(refs.days)}`,
    );
  }

  const squads = await squadsOf(env, user.id);
  if (squads.length) {
    lines.push(`<b>Группы</b>: ${squads.map((item) => escapeHtml(item.squad)).join(", ")}`);
  }

  lines.push(
    "",
    user.status === "active"
      ? `<code>${escapeHtml(linkFor(env, user.sub_token))}</code>`
      : "Ссылка станет активной после одобрения.",
  );

  return lines.join("\n");
}

export async function sendCabinet(
  env: Env,
  chatId: number | string,
  user: UserRow | null,
  messageId?: number,
): Promise<void> {
  if (!user) {
    await sendMessage(env, chatId, "Заявки пока нет. Нажмите /start.");
    return;
  }
  const settings = await loadSettings(env);
  const body = await cabinetBody(env, user);
  await screen(
    env,
    chatId,
    messageId,
    "account",
    body,
    cabinetKeyboard({
      daily: flag(settings, "daily_enabled", true),
      referral: flag(settings, "referral_enabled", true),
      promo: flag(settings, "promo_enabled", true),
      bypass: flag(settings, "squads_enabled", false) && user.status === "active",
      active: user.status === "active",
    }),
  );
}

export async function sendHelp(
  env: Env,
  chatId: number | string,
  messageId?: number,
): Promise<void> {
  await screen(env, chatId, messageId, "start", HELP, mainKeyboard({ referral: true }));
}

/* ── бонус дня ─────────────────────────────────────────────────────────── */

export async function claimBonusText(env: Env, user: UserRow): Promise<string> {
  const settings = await loadSettings(env);
  const result = await claimDaily(env, user);

  if (result.ok) {
    const until = result.expiresAt?.slice(0, 10) ?? "—";
    return (
      `🎁 +${humanDuration(result.hours)}\n` +
      `Серия: ${result.streak} ${plural(result.streak, "день", "дня", "дней")}\n` +
      `Доступ до ${until}.`
    );
  }

  switch (result.reason) {
    case "already": {
      const waitMs = Math.max(0, nextMskMidnight() - Date.now());
      const hours = Math.floor(waitMs / 3600_000);
      const minutes = Math.round((waitMs % 3600_000) / 60_000);
      return `Бонус на сегодня уже получен.\nСледующий через ${hours} ч ${minutes} мин.`;
    }
    case "month_cap":
      return `Месячный лимит бонусов выбран (${num(settings, "daily_month_cap_hours", 48)} ч). В следующем месяце — снова.`;
    case "inactive":
      return "Бонусы станут доступны после одобрения доступа.";
    case "disabled":
      return "Бонусы временно выключены.";
    default:
      return "Не получилось начислить бонус. Попробуйте позже.";
  }
}

/* ── рефералы ──────────────────────────────────────────────────────────── */

export async function sendReferral(
  env: Env,
  chatId: number | string,
  user: UserRow,
  messageId?: number,
): Promise<void> {
  const settings = await loadSettings(env);
  const stats = await referralStats(env, user.id);
  const reward = num(settings, "referral_reward_days", 1);

  const text = [
    `<b>Пригласите друга</b>`,
    `Он получает ${humanDuration(reward * 24)}, вы — столько же, когда он активирует доступ.`,
    "",
    `Приглашено: ${stats.invited}`,
    `Награждено: ${stats.rewarded}`,
    `Заработано: ${humanDuration(stats.days)}`,
    "",
    `<code>${escapeHtml(stats.link)}</code>`,
  ].join("\n");

  await screen(env, chatId, messageId, "account", text, referralKeyboard(stats.link));
}

/* ── промокоды ─────────────────────────────────────────────────────────── */

export async function handlePromoCode(env: Env, user: UserRow, code: string): Promise<string> {
  const result = await redeemPromo(env, user, code);
  if (!result.ok) {
    switch (result.reason) {
      case "empty":
        return "Пустой код. Пример: <code>/promo ORANGE2026</code>";
      case "not_found":
        return "Такого промокода нет.";
      case "expired":
        return "Промокод истёк.";
      case "limit":
        return "Лимит активаций исчерпан.";
      case "used":
        return "Вы уже использовали этот код.";
      case "disabled":
        return "Промокоды временно выключены.";
      default:
        return "Не получилось активировать код.";
    }
  }

  const parts: string[] = [];
  if (result.days) parts.push(`+${humanDuration(result.days * 24)}`);
  if (result.hours) parts.push(`+${humanDuration(result.hours)}`);
  if (result.gb) parts.push(`+${result.gb} ГБ`);
  if (result.squad) parts.push(`группа ${escapeHtml(result.squad)}`);

  const fresh = await findUser(env, user.tg_id);
  return (
    `🎟 Промокод активирован: ${parts.join(", ") || "бонус"}\n` +
    `Доступ до ${fresh?.expires_at?.slice(0, 10) ?? "—"}.`
  );
}

/* ── обход белых списков (Bypass) ──────────────────────────────────────── */

export async function handleBypass(
  env: Env,
  user: UserRow,
): Promise<{ text: string; changed: boolean }> {
  const settings = await loadSettings(env);
  if (!flag(settings, "squads_enabled", false)) {
    return { text: "Обход белых списков пока недоступен.", changed: false };
  }
  const squads = await squadsOf(env, user.id);
  const active = squads.some((item) => item.squad === "Bypass");

  if (active) {
    await revokeSquad(env, user.id, "Bypass");
    await logEvent(env, "squad_off", user.id, "Bypass снят");
    return { text: "Обход белых списков выключен.", changed: true };
  }

  await grantSquad(env, user.id, "Bypass", 30);
  await logEvent(env, "squad_on", user.id, "Bypass на 30 дней");
  return { text: "Обход белых списков включён на 30 дней.", changed: true };
}

/* ── проверка канала ───────────────────────────────────────────────────── */

export async function checkChannel(
  env: Env,
  user: UserRow,
): Promise<{ ok: boolean; text: string }> {
  const result = await claimChannel(env, user);
  if (result.ok) {
    return { ok: true, text: "Спасибо за подписку! День доступа уже на счету." };
  }
  switch (result.reason) {
    case "no_channel":
      return { ok: true, text: "Проверка канала не настроена." };
    case "not_member":
      return { ok: false, text: "Подписки пока не видно. Подпишитесь и нажмите ещё раз." };
    case "already":
      return { ok: true, text: "Награда за канал уже получена." };
    default:
      return { ok: false, text: "Не получилось проверить. Попробуйте позже." };
  }
}

/* ── команды ───────────────────────────────────────────────────────────── */

/* ── чипы с баннера «Ваш аккаунт»: Срок · Трафик · Устройства ─────────── */

export async function sendTerm(
  env: Env,
  chatId: number | string,
  user: UserRow,
  messageId?: number,
): Promise<void> {
  const until = user.expires_at?.slice(0, 10) ?? "не задан";
  const ts = Date.parse(`${(user.expires_at ?? "").replace(" ", "T")}Z`);
  const days = Number.isFinite(ts) ? Math.ceil((ts - Date.now()) / 86400_000) : 0;

  const lines = [
    `<b>Срок доступа</b>`,
    `До: ${until}`,
    Number.isFinite(days) && days > 0
      ? `Осталось: ${days} ${plural(days, "день", "дня", "дней")}`
      : "Срок истёк или ещё не выдан",
    "",
    "Продлить можно бонусом дня, промокодом или у администратора.",
  ];
  await screen(
    env,
    chatId,
    messageId,
    "account",
    lines.join("\n"),
    cabinetKeyboard({ referral: true, promo: true, active: user.status === "active" }),
  );
}

export async function sendTraffic(
  env: Env,
  chatId: number | string,
  user: UserRow,
  messageId?: number,
): Promise<void> {
  const limit = user.traffic_gb ? `${user.traffic_gb} ГБ` : "без лимита";
  const lines = [
    `<b>Трафик</b>`,
    `Лимит: ${limit}`,
    "",
    user.traffic_gb
      ? "Израсходованное считает сервер: Happ показывает остаток в карточке подписки и обновляет его каждые 6 часов."
      : "Трафик не ограничен — качайте сколько нужно.",
  ];
  await screen(env, chatId, messageId, "account", lines.join("\n"), cabinetKeyboard({ referral: true }));
}

function ago(value: string): string {
  const stamp = value.length <= 13 ? `${value}:00:00` : value;
  const ts = Date.parse(`${stamp.replace(" ", "T")}Z`);
  if (!Number.isFinite(ts)) return "—";
  const minutes = Math.max(0, Math.round((Date.now() - ts) / 60000));
  if (minutes < 60) return `${minutes} мин назад`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return `${hours} ч назад`;
  const days = Math.round(hours / 24);
  return `${days} ${plural(days, "день", "дня", "дней")} назад`;
}

/** Экран «Устройства»: имена клиентов и отвязка по одному. */
export async function sendDevicesInfo(
  env: Env,
  chatId: number | string,
  user: UserRow,
  messageId?: number,
): Promise<void> {
  const devices = await listDevices(env, user.id);
  const active = devices.filter((item) => !item.blocked);
  const blocked = devices.filter((item) => item.blocked);

  const lines = [
    `<b>Устройства</b>`,
    `Лимит: ${user.device_limit} · подключено: ${active.length}`,
    "",
  ];

  if (active.length) {
    active.forEach((item, index) => {
      lines.push(`${index + 1}. ${escapeHtml(item.label)} — ${ago(item.last_seen)}`);
    });
  } else {
    lines.push("Пока ни одно устройство не открывало подписку.");
  }

  if (blocked.length) {
    lines.push("", "<b>Отключены</b>");
    blocked.forEach((item) => lines.push(`• ${escapeHtml(item.label)}`));
  }

  lines.push(
    "",
    "Отвязать можно одно устройство — остальные продолжат работать.",
  );

  const rows: Array<Array<{ text: string; callback_data: string }>> = [];
  for (const item of active.slice(0, 5)) {
    rows.push([{ text: `✖️ Отвязать ${item.label}`, callback_data: `dvb:${item.id}` }]);
  }
  for (const item of blocked.slice(0, 3)) {
    rows.push([{ text: `↩️ Вернуть ${item.label}`, callback_data: `dvu:${item.id}` }]);
  }
  rows.push([{ text: "🔄 Отключить все", callback_data: "dev:kick" }]);
  rows.push([
    { text: "👤 Кабинет", callback_data: "act:cabinet" },
    { text: "← В меню", callback_data: "act:menu" },
  ]);

  await screen(env, chatId, messageId, "account", lines.join("\n"), { inline_keyboard: rows });
}

/** Подтверждение: перевыпуск ссылки выкидывает все устройства сразу. */
export async function confirmKickDevices(
  env: Env,
  chatId: number | string,
  user: UserRow,
  messageId?: number,
): Promise<void> {
  const used = await devices24h(env, user.id);
  const text = [
    "<b>Отключить все устройства?</b>",
    "",
    `Сейчас в сети: ${used}.`,
    "Ссылка перевыпустится, старая перестанет работать на всех устройствах —",
    "включая это. Понадобится добавить новую в Happ.",
    "",
    "Это действие нельзя отменить.",
  ].join("\n");

  await screen(env, chatId, messageId, "account", text, {
    inline_keyboard: [
      [{ text: "✅ Да, отключить", callback_data: "dev:kick_yes" }],
      [{ text: "Отмена", callback_data: "act:devs" }],
    ],
  });
}

/**
 * Само отключение: новый токен подписки + очистка истории устройств.
 * Старые клиенты ходят по старому токену и получают 404.
 */
export async function kickDevices(
  env: Env,
  chatId: number | string,
  user: UserRow,
  messageId?: number,
): Promise<void> {
  const token = await rotateToken(env, user);
  await run(env, "DELETE FROM fetch_log WHERE user_id = ?", user.id);
  await logEvent(env, "devices_kick", user.id, "все устройства отключены");

  const text = [
    "<b>Готово, устройства отключены</b>",
    "",
    "Старая ссылка больше не работает. Добавьте новую на нужном устройстве:",
    `<code>${escapeHtml(linkFor(env, token))}</code>`,
  ].join("\n");

  await screen(env, chatId, messageId, "account", text, cabinetKeyboard({ referral: true, active: true }));
}

export async function handleKey(env: Env, user: UserRow): Promise<void> {
  if (user.status !== "active") {
    await sendMessage(env, user.tg_id, `Ссылка недоступна: ${user.status}.`);
    return;
  }
  await screen(
    env,
    user.tg_id,
    undefined,
    "account",
    `<b>Ваша ссылка</b>\n<code>${escapeHtml(linkFor(env, user.sub_token))}</code>`,
    cabinetKeyboard({ referral: true, active: true }),
  );
}

export async function handleStatus(env: Env, user: UserRow, messageId?: number): Promise<void> {
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

  await screen(
    env,
    user.tg_id,
    messageId,
    "account",
    lines.join("\n"),
    cabinetKeyboard({ referral: true, promo: true, active: user.status === "active" }),
  );
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
      "/bonus — бонус дня",
      "/promo КОД — активировать промокод",
      "/help — эта справка",
      "",
      "Если ничего не работает — напишите админу, он проверит серверы.",
    ].join("\n"),
    mainKeyboard({ referral: true }),
  );
}

/** Подпись «сегодня 21 октября» — для уведомлений. */
export function todayLabel(): string {
  return mskDate();
}
