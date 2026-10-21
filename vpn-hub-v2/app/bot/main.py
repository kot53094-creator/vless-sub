"""Точка входа бота. Этап 4: aiogram, триал, кабинет, инструкции.

Пока модуль не собран, контейнер честно говорит об этом и выходит,
чтобы не крутиться в цикле перезапусков.
"""

from __future__ import annotations

import sys

from ..config import settings


def main() -> int:
    if not settings.bot_token:
        print("BOT_TOKEN не задан — бот выключен.", file=sys.stderr)
        return 1
    print(
        "Бот появится на этапе 4: /start, пробный период, кабинет и инструкции "
        "для устройств. Сайт и подписка работают без него.",
        file=sys.stderr,
    )
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
