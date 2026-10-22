/** Тексты и клавиатуры бота. Крупные кнопки, короткие фразы. */

import type { ReplyMarkup } from "./telegram";

import { BRAND } from "../brand";

export { BRAND };

export const WELCOME =
  `<b>${BRAND}</b>\n` +
  "Свободный интернет начинается здесь.\n\n" +
  "⚡️ Быстрое подключение\n" +
  "🛡 Без логов и рекламы\n" +
  "📱 До 3 устройств\n\n" +
  "Выберите, что нужно.";

export const DEVICES: Array<{ key: string; label: string }> = [
  { key: "windows", label: "Windows" },
  { key: "ios", label: "iOS" },
  { key: "android", label: "Android" },
  { key: "macos", label: "macOS" },
  { key: "linux", label: "Linux" },
];

export const INSTRUCTIONS: Record<string, string> = {
  windows:
    "1. Скачайте <b>Happ</b> с happ.su и установите.\n" +
    "2. Нажмите «+» → «Импорт по ссылке».\n" +
    "3. Вставьте ссылку из кабинета.\n" +
    "4. Выберите сервер и включите.",
  ios:
    "1. Установите <b>Happ</b> из App Store.\n" +
    "2. Нажмите «+» → «Добавить подписку».\n" +
    "3. Вставьте ссылку из кабинета.\n" +
    "4. Выберите сервер и включите.",
  android:
    "1. Установите <b>Happ</b> из Google Play.\n" +
    "2. Нажмите «+» → «Импорт по ссылке».\n" +
    "3. Вставьте ссылку из кабинета.\n" +
    "4. Выберите сервер и включите.",
  macos:
    "1. Скачайте <b>Happ</b> для macOS.\n" +
    "2. Нажмите «+» → «Импорт по ссылке».\n" +
    "3. Вставьте ссылку из кабинета.\n" +
    "4. Выберите сервер и включите.",
  linux:
    "1. Скачайте <b>Happ</b> (AppImage) с happ.su.\n" +
    "2. Разрешите запуск и откройте.\n" +
    "3. Нажмите «+» → «Импорт по ссылке».\n" +
    "4. Выберите сервер и включите.",
};

export interface KeyboardOptions {
  daily?: boolean;
  referral?: boolean;
  promo?: boolean;
  bypass?: boolean;
  active?: boolean;
}

export function mainKeyboard(options: KeyboardOptions = {}): ReplyMarkup {
  const rows: ReplyMarkup["inline_keyboard"] = [
    [{ text: "⚡️ Включить VPN", callback_data: "act:devices" }],
  ];

  if (options.daily !== false) {
    rows.push([{ text: "🎁 Бонус дня", callback_data: "bon:claim" }]);
  }

  rows.push([
    { text: "👤 Кабинет", callback_data: "act:cabinet" },
    { text: "💳 Тарифы", callback_data: "act:plans" },
  ]);

  if (options.referral) {
    rows.push([{ text: "👥 Пригласить друга", callback_data: "ref:show" }]);
  }

  rows.push([
    { text: "📊 Состояние", callback_data: "act:status" },
    { text: "🔄 Обновить всё", callback_data: "act:refresh" },
  ]);
  rows.push([{ text: "❓ Помощь", callback_data: "act:help" }]);
  return { inline_keyboard: rows };
}

export function cabinetKeyboard(options: KeyboardOptions = {}): ReplyMarkup {
  // Первый ряд повторяет чипы с баннера «Ваш аккаунт»: Срок · Трафик · Устройства.
  const rows: ReplyMarkup["inline_keyboard"] = [
    [
      { text: "📅 Срок", callback_data: "act:term" },
      { text: "📊 Трафик", callback_data: "act:traffic" },
      { text: "📱 Устройства", callback_data: "act:devs" },
    ],
  ];

  if (options.daily !== false) {
    rows.push([{ text: "🎁 Забрать бонус дня", callback_data: "bon:claim" }]);
  }

  const extras: Array<{ text: string; callback_data: string }> = [];
  if (options.referral) extras.push({ text: "👥 Пригласить друга", callback_data: "ref:show" });
  if (options.promo) extras.push({ text: "🎟 Промокод", callback_data: "prm:enter" });
  if (extras.length) rows.push(extras);

  if (options.bypass) {
    rows.push([{ text: "🛡 Обход белых списков", callback_data: "sq:bypass" }]);
  }

  rows.push([{ text: "🌍 Выбрать сервер", callback_data: "srv:list" }]);
  rows.push([{ text: "⚡️ Как подключить", callback_data: "act:devices" }]);
  if (options.active) {
    rows.push([{ text: "♻️ Новая ссылка", callback_data: "act:newkey" }]);
  }
  rows.push([{ text: "← В меню", callback_data: "act:menu" }]);
  return { inline_keyboard: rows };
}

/**
 * Раскладка повторяет чипы с баннера «Подключите VPN»:
 * macOS · Linux · Android · iOS · Windows.
 */
export function deviceKeyboard(): ReplyMarkup {
  const label = (key: string) => DEVICES.find((item) => item.key === key)?.label ?? key;
  const row = (keys: string[]) =>
    keys.map((key) => ({ text: label(key), callback_data: `dev:${key}` }));
  return {
    inline_keyboard: [
      row(["macos", "linux"]),
      row(["android", "ios", "windows"]),
      [{ text: "← В меню", callback_data: "act:menu" }],
    ],
  };
}

/** Кнопки под баннером «Подписка активирована» / «Пробный период». */
export function activatedKeyboard(): ReplyMarkup {
  return {
    inline_keyboard: [
      [{ text: "⚡️ Как подключить", callback_data: "act:devices" }],
      [{ text: "👤 Кабинет", callback_data: "act:cabinet" }],
    ],
  };
}

/** Кнопки под баннером «Заканчивается» — то же, что в уведомлении. */
export function expiringKeyboard(): ReplyMarkup {
  return {
    inline_keyboard: [
      [
        { text: "👤 Кабинет", callback_data: "act:cabinet" },
        { text: "🎁 Бонус дня", callback_data: "bon:claim" },
      ],
    ],
  };
}

export function backKeyboard(): ReplyMarkup {
  return {
    inline_keyboard: [
      [{ text: "👤 Кабинет", callback_data: "act:cabinet" }],
      [{ text: "← В меню", callback_data: "act:menu" }],
    ],
  };
}

export function channelKeyboard(url: string): ReplyMarkup {
  return {
    inline_keyboard: [
      [{ text: "📣 Открыть канал", url }],
      [{ text: "✅ Я подписался", callback_data: "chk:sub" }],
      [{ text: "👤 Кабинет", callback_data: "act:cabinet" }],
    ],
  };
}

export function referralKeyboard(link: string): ReplyMarkup {
  return {
    inline_keyboard: [
      [
        {
          text: "📤 Поделиться",
          url: `https://t.me/share/url?url=${encodeURIComponent(link)}&text=${encodeURIComponent("VPN без блокировок")}`,
        },
      ],
      [{ text: "👤 Кабинет", callback_data: "act:cabinet" }],
    ],
  };
}

export const HELP =
  `<b>${BRAND} · помощь</b>\n\n` +
  "1. Нажмите «⚡️ Включить VPN».\n" +
  "2. Выберите устройство.\n" +
  "3. Установите Happ и вставьте ссылку.\n\n" +
  "Бонусы: «🎁 Бонус дня» продлевает подписку.\n" +
  "Друзья: «👥 Пригласить друга» даёт дни обоим.\n\n" +
  "Если сервер не работает — «🔄 Обновить всё»:\n" +
  "мёртвые уйдут из списка, ссылка пересоберётся.";
