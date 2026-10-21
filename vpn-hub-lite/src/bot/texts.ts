/** Тексты и клавиатуры бота. Крупные кнопки, короткие фразы. */

import type { ReplyMarkup } from "./telegram";

export const BRAND = "Apelsinka VPN";

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

export function mainKeyboard(): ReplyMarkup {
  return {
    inline_keyboard: [
      [{ text: "⚡️ Включить VPN", callback_data: "act:devices" }],
      [
        { text: "👤 Кабинет", callback_data: "act:cabinet" },
        { text: "💳 Тарифы", callback_data: "act:plans" },
      ],
      [
        { text: "📊 Состояние", callback_data: "act:status" },
        { text: "🔄 Обновить всё", callback_data: "act:refresh" },
      ],
      [{ text: "❓ Помощь", callback_data: "act:help" }],
    ],
  };
}

export function deviceKeyboard(): ReplyMarkup {
  const rows = [];
  for (let i = 0; i < DEVICES.length; i += 2) {
    rows.push(
      DEVICES.slice(i, i + 2).map((device) => ({
        text: device.label,
        callback_data: `dev:${device.key}`,
      })),
    );
  }
  rows.push([{ text: "← Назад", callback_data: "act:menu" }]);
  return { inline_keyboard: rows };
}

export function backKeyboard(): ReplyMarkup {
  return {
    inline_keyboard: [
      [{ text: "👤 Кабинет", callback_data: "act:cabinet" }],
      [{ text: "← В меню", callback_data: "act:menu" }],
    ],
  };
}

export const HELP =
  `<b>${BRAND} · помощь</b>\n\n` +
  "1. Нажмите «⚡️ Включить VPN».\n" +
  "2. Выберите устройство.\n" +
  "3. Установите Happ и вставьте ссылку.\n\n" +
  "Если сервер не работает — «🔄 Обновить всё»:\n" +
  "мёртвые уйдут из списка, ссылка пересоберётся.";
