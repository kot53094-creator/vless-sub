"""Пароль, сессия, CSRF, лимит попыток, маскирование."""

from __future__ import annotations

import secrets
import time
from collections import defaultdict

from argon2 import PasswordHasher
from argon2.exceptions import VerifyMismatchError
from fastapi import HTTPException, Request

from .config import settings

_hasher = PasswordHasher()
_attempts: dict[str, list[float]] = defaultdict(list)
WINDOW = 600
MAX_ATTEMPTS = 6


def hash_password(password: str) -> str:
    return _hasher.hash(password)


def verify_password(password: str) -> bool:
    stored = settings.admin_password_hash
    if stored:
        try:
            return _hasher.verify(stored, password)
        except (VerifyMismatchError, Exception):  # noqa: BLE001
            return False
    # запасной путь для локального запуска: пароль прямо в .env
    return bool(settings.admin_password) and secrets.compare_digest(
        settings.admin_password, password
    )


def too_many_attempts(ip: str) -> bool:
    now = time.time()
    hits = [t for t in _attempts[ip] if now - t < WINDOW]
    _attempts[ip] = hits
    return len(hits) >= MAX_ATTEMPTS


def register_attempt(ip: str) -> None:
    _attempts[ip].append(time.time())


_rate: dict[str, list[float]] = defaultdict(list)


def mem_rate(key: str, limit: int, window: int) -> bool:
    """Простой лимит в памяти процесса: без БД и без лишних записей."""
    now = time.time()
    hits = [t for t in _rate[key] if now - t < window]
    if len(hits) >= limit:
        _rate[key] = hits
        return False
    hits.append(now)
    _rate[key] = hits
    return True


def current_user(request: Request) -> str | None:
    return request.session.get("user")


def require_user(request: Request) -> str:
    user = current_user(request)
    if not user:
        raise HTTPException(status_code=401, detail="Нужен вход")
    return user


def csrf_token(request: Request) -> str:
    token = request.session.get("csrf")
    if not token:
        token = secrets.token_urlsafe(24)
        request.session["csrf"] = token
    return token


def check_csrf(request: Request, value: str) -> None:
    expected = request.session.get("csrf", "")
    if not expected or not secrets.compare_digest(expected, value or ""):
        raise HTTPException(status_code=403, detail="Проверка формы не прошла. Обновите страницу.")


def totp_enabled() -> bool:
    return bool(settings.totp_secret)


def verify_totp(code: str) -> bool:
    if not settings.totp_secret:
        return True
    try:
        import pyotp

        return bool(pyotp.TOTP(settings.totp_secret).verify((code or "").strip(), valid_window=1))
    except Exception:  # noqa: BLE001
        return False


def mask(value: str, head: int = 16, tail: int = 4) -> str:
    if not value:
        return ""
    if len(value) <= head + tail + 3:
        return value[:6] + "…"
    return f"{value[:head]}…{value[-tail:]}"


def sub_url(token: str | None = None) -> str:
    return f"{settings.app_url}/sub/{token or settings.sub_token}"
