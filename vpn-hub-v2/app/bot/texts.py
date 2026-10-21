"""Тексты бота. Короткие фразы, крупные кнопки, без терминов."""

from __future__ import annotations

import os

from sqlalchemy.orm import Session

from ..models import Setting

BRAND = os.getenv("BOT_NAME", "Apelsinka VPN")

WELCOME = (
    f"<b>{BRAND}</b>\n"
    "Свободный интернет начинается здесь.\n\n"
    "⚡️ Быстрое подключение\n"
    "🛡 Без логов и рекламы\n"
    "📱 До 3 устройств\n\n"
    "Выберите, что нужно."
)

WELCOME_BUTTONS = [
    [("⚡️ Включить VPN", "act:devices")],
    [("👤 Кабинет", "act:cabinet"), ("💳 Тарифы", "act:plans")],
    [("📊 Состояние", "act:status"), ("🔄 Обновить всё", "act:refresh")],
    [("❓ Помощь", "act:help")],
]

DEVICE_TITLES = {
    "android": "Android",
    "ios": "iOS",
    "windows": "Windows",
    "macos": "macOS",
    "linux": "Linux",
}

DEVICE_ICONS = {
    "android": "🤖",
    "ios": "🍏",
    "windows": "🪟",
    "macos": "💻",
    "linux": "🐧",
}

DEFAULT_INSTRUCTIONS = {
    "android": (
        "1. Установите <b>Happ</b> из Google Play.\n"
        "2. Нажмите «+» → «Импорт по ссылке».\n"
        "3. Вставьте ссылку из кабинета.\n"
        "4. Выберите сервер и включите."
    ),
    "ios": (
        "1. Установите <b>Happ</b> из App Store.\n"
        "2. Нажмите «+» → «Добавить подписку».\n"
        "3. Вставьте ссылку из кабинета.\n"
        "4. Выберите сервер и включите."
    ),
    "windows": (
        "1. Скачайте <b>Happ</b> с happ.su.\n"
        "2. Нажмите «+» → «Импорт по ссылке».\n"
        "3. Вставьте ссылку из кабинета.\n"
        "4. Выберите сервер и включите."
    ),
    "macos": (
        "1. Скачайте <b>Happ</b> для macOS.\n"
        "2. Нажмите «+» → «Импорт по ссылке».\n"
        "3. Вставьте ссылку из кабинета.\n"
        "4. Выберите сервер и включите."
    ),
    "linux": (
        "1. Скачайте <b>Happ</b> (AppImage) с happ.su.\n"
        "2. Разрешите запуск и откройте.\n"
        "3. Нажмите «+» → «Импорт по ссылке».\n"
        "4. Выберите сервер и включите."
    ),
}


def instruction(db: Session, device: str) -> str:
    row = db.get(Setting, f"instruction.{device}")
    if row and row.value:
        return row.value
    return DEFAULT_INSTRUCTIONS.get(device, DEFAULT_INSTRUCTIONS["android"])


def device_menu() -> list[list[tuple[str, str]]]:
    """Ряды как на макете: по две кнопки в ряд, «Назад» снизу."""
    return [
        [("Windows", "dev:windows"), ("iOS", "dev:ios")],
        [("Android", "dev:android"), ("macOS", "dev:macos")],
        [("Linux", "dev:linux")],
        [("← Назад", "act:back")],
    ]


HELP = (
    f"<b>{BRAND} · помощь</b>\n\n"
    "1. Нажмите «⚡️ Включить VPN».\n"
    "2. Выберите устройство.\n"
    "3. Установите Happ и вставьте ссылку.\n\n"
    "Если сервер не работает — нажмите «🔄 Обновить всё»:\n"
    "мёртвые уйдут из списка, ссылка пересоберётся."
)

NO_LINK = (
    "Ссылка пока не готова: в хабе нет живых серверов.\n"
    "Нажмите «🔄 Обновить всё» или напишите администратору."
)

NO_ACCESS = "Доступ закрыт. Напишите администратору."
