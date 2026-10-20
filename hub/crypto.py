"""Шифрование SSH-секретов.

Ключ выводится из `HUB_SECRET_KEY` через sha256 — отдельная переменная не
нужна, но при смене секрета старые записи расшифровать не получится.
"""

from __future__ import annotations

import base64
import hashlib

from cryptography.fernet import Fernet, InvalidToken

from .config import settings


def _fernet() -> Fernet:
    digest = hashlib.sha256((settings.secret_key or "hub-dev-secret").encode()).digest()
    return Fernet(base64.urlsafe_b64encode(digest))


def encrypt(plain: str) -> str:
    return _fernet().encrypt(plain.encode("utf-8")).decode("ascii")


def decrypt(token: str) -> str:
    if not token:
        return ""
    try:
        return _fernet().decrypt(token.encode("ascii")).decode("utf-8")
    except (InvalidToken, ValueError):
        return ""


def fingerprint(value: str) -> str:
    """Короткий отпечаток для логов: сам секрет не печатаем."""
    if not value:
        return "—"
    return hashlib.sha256(value.encode()).hexdigest()[:8]
