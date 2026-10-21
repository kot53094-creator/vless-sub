"""Тексты бота. Короткие фразы, без жаргона."""

from __future__ import annotations

from sqlalchemy.orm import Session

from ..models import Setting

WELCOME = (
    "<b>VPN Hub</b>\n"
    "Здесь ваша ссылка для Happ и состояние серверов.\n\n"
    "Выберите, что нужно."
)

DEVICE_TITLES = {
    "android": "Android",
    "ios": "iPhone",
    "windows": "Windows",
    "macos": "macOS",
    "linux": "Linux",
}

# 3–4 шага, без терминов. Можно переписать в админке (ключ instruction.<device>).
DEFAULT_INSTRUCTIONS = {
    "android": (
        "1. Откройте Google Play и установите <b>Happ</b>.\n"
        "2. В приложении нажмите «+» → «Импорт по ссылке».\n"
        "3. Вставьте ссылку и сохраните.\n"
        "4. Выберите сервер и нажмите большую кнопку включения."
    ),
    "ios": (
        "1. Откройте App Store и установите <b>Happ</b>.\n"
        "2. Нажмите «+» → «Добавить подписку».\n"
        "3. Вставьте ссылку и сохраните.\n"
        "4. Выберите сервер и включите VPN."
    ),
    "windows": (
        "1. Скачайте <b>Happ</b> с happ.su и установите.\n"
        "2. Нажмите «+» → «Импорт по ссылке».\n"
        "3. Вставьте ссылку и сохраните.\n"
        "4. Выберите сервер и включите подключение."
    ),
    "macos": (
        "1. Скачайте <b>Happ</b> для macOS и откройте.\n"
        "2. Нажмите «+» → «Импорт по ссылке».\n"
        "3. Вставьте ссылку и сохраните.\n"
        "4. Выберите сервер и включите VPN."
    ),
    "linux": (
        "1. Скачайте <b>Happ</b> (AppImage) с happ.su.\n"
        "2. Разрешите запуск файла и откройте его.\n"
        "3. Нажмите «+» → «Импорт по ссылке», вставьте ссылку.\n"
        "4. Выберите сервер и включите VPN."
    ),
}


def instruction(db: Session, device: str) -> str:
    """Текст из админки, если он там есть, иначе стандартный."""
    row = db.get(Setting, f"instruction.{device}")
    if row and row.value:
        return row.value
    return DEFAULT_INSTRUCTIONS.get(device, DEFAULT_INSTRUCTIONS["android"])


def device_menu() -> list[list[tuple[str, str]]]:
    """Ряды кнопок: [(подпись, callback), ...]."""
    return [
        [("Android", "dev:android"), ("iPhone", "dev:ios")],
        [("Windows", "dev:windows"), ("macOS", "dev:macos")],
        [("Linux", "dev:linux")],
    ]


WELCOME_BUTTONS = [
    [("Моя ссылка", "act:link"), ("Как подключить", "act:devices")],
    [("Состояние", "act:status"), ("Обновить всё", "act:refresh")],
    [("Помощь", "act:help")],
]

HELP = (
    "<b>Что делать</b>\n"
    "• «Моя ссылка» — скопируйте её в Happ.\n"
    "• «Как подключить» — короткая инструкция для вашего устройства.\n"
    "• «Обновить всё» — хаб проверит серверы и пересоберёт ссылку.\n\n"
    "Если сервер не работает, нажмите «Обновить всё»: мёртвые уйдут из списка."
)

NO_LINK = (
    "Ссылка пока не готова: в хабе нет живых серверов.\n"
    "Добавьте ключ командой /addkey."
)

NO_ACCESS = "Доступ закрыт. Напишите администратору."
