"""Права и частота команд — без зависимостей от aiogram, чтобы было проще тестировать."""

from __future__ import annotations

import time
from collections import defaultdict

from ..config import settings

_hits: dict[int, list[float]] = defaultdict(list)


def is_admin(user_id: int | None) -> bool:
    return user_id is not None and str(user_id) == str(settings.admin_tg_id)


def rate_ok(user_id: int, limit: int = 12, window: int = 60) -> bool:
    """Не больше `limit` команд в минуту с одного аккаунта."""
    now = time.time()
    hits = [stamp for stamp in _hits[user_id] if now - stamp < window]
    if len(hits) >= limit:
        _hits[user_id] = hits
        return False
    hits.append(now)
    _hits[user_id] = hits
    return True


def reset() -> None:
    """Для тестов."""
    _hits.clear()
