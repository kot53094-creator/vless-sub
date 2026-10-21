"""Запуск бота: aiogram 3, long polling.

Токен — существующего бота, новый создавать не нужно.
Если Telegram недоступен из вашей сети, укажите TELEGRAM_PROXY.
"""

from __future__ import annotations

import asyncio
import logging
import sys

from aiogram import Bot, Dispatcher
from aiogram.client.default import DefaultBotProperties
from aiogram.client.session.aiohttp import AiohttpSession
from aiogram.enums import ParseMode
from aiogram.exceptions import TelegramNetworkError, TelegramUnauthorizedError
from aiogram.types import BotCommand

from ..config import settings
from ..db import init_db
from .handlers import router

log = logging.getLogger("vpnhub.bot")

COMMANDS = [
    BotCommand(command="start", description="Главное меню"),
    BotCommand(command="link", description="Моя ссылка для Happ"),
    BotCommand(command="status", description="Состояние серверов"),
    BotCommand(command="refresh", description="Обновить всё"),
    BotCommand(command="addkey", description="Добавить ключ"),
    BotCommand(command="mode", description="Режим сети"),
    BotCommand(command="report", description="Список источников"),
    BotCommand(command="help", description="Помощь"),
]


def build_dispatcher() -> Dispatcher:
    dp = Dispatcher()
    dp.include_router(router)
    return dp


def build_bot() -> Bot:
    session = AiohttpSession(proxy=settings.telegram_proxy or None)
    return Bot(
        token=settings.bot_token,
        session=session,
        default=DefaultBotProperties(parse_mode=ParseMode.HTML),
    )


async def run() -> int:
    bot = build_bot()
    dp = build_dispatcher()

    try:
        me = await bot.get_me()
    except TelegramUnauthorizedError:
        log.error("Telegram отклонил токен. Проверьте BOT_TOKEN в .env")
        return 1
    except TelegramNetworkError as exc:
        log.error(
            "Нет связи с Telegram (%s). Если сеть блокирует api.telegram.org, "
            "укажите TELEGRAM_PROXY=http://user:pass@host:port в .env",
            type(exc).__name__,
        )
        return 1

    await bot.set_my_commands(COMMANDS)
    log.info("Бот @%s запущен. Админ: %s", me.username, settings.admin_tg_id)

    try:
        await bot.send_message(
            settings.admin_tg_id,
            "<b>VPN Hub</b>: бот на связи.\n"
            "Команды: /link, /status, /refresh, /addkey, /report.",
        )
    except Exception:  # noqa: BLE001 - админ мог не начинать диалог
        log.warning("Не смог написать админу. Откройте бота и нажмите /start")

    try:
        await dp.start_polling(bot, allowed_updates=["message", "callback_query"])
    finally:
        await bot.session.close()
    return 0


def main(argv: list[str] | None = None) -> int:
    logging.basicConfig(
        level=logging.INFO,
        format="%(asctime)s %(levelname)s %(message)s",
    )

    if argv and "--check" in argv:
        # Проверка без сети: конфиг, роутер, команды.
        from .handlers import router as bot_router

        build_dispatcher()  # проверяем, что роутер подключается без ошибок
        handlers = len(bot_router.message.handlers) + len(bot_router.callback_query.handlers)
        print(f"токен: {'есть' if settings.bot_token else 'нет'}")
        print(f"админ: {settings.admin_tg_id}")
        print(f"прокси: {settings.telegram_proxy or 'не задан'}")
        print(f"обработчиков: {handlers}")
        return 0

    if not settings.bot_token:
        print("BOT_TOKEN не задан — бот выключен, сайт работает без него.", file=sys.stderr)
        return 0

    init_db()
    try:
        return asyncio.run(run())
    except KeyboardInterrupt:
        return 0


if __name__ == "__main__":
    raise SystemExit(main(sys.argv[1:]))
