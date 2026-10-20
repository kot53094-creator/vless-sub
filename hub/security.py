"""Вход, сессии, CSRF и защита от перебора пароля."""

from __future__ import annotations

import secrets
import time
from collections import defaultdict

from argon2 import PasswordHasher
from argon2.exceptions import VerifyMismatchError
from fastapi import HTTPException, Request, status
from itsdangerous import BadSignature, URLSafeTimedSerializer

from .config import settings

COOKIE_SESSION = "hub_session"
COOKIE_CSRF = "hub_csrf"

_hasher = PasswordHasher()
_serializer = URLSafeTimedSerializer(settings.secret_key or "hub-dev-secret", salt="hub-session")

_attempts: dict[str, list[float]] = defaultdict(list)
WINDOW = 300
LIMIT = 8


def hash_password(plain: str) -> str:
    return _hasher.hash(plain)


def verify_password(plain: str) -> bool:
    if settings.admin_password_hash:
        try:
            return _hasher.verify(settings.admin_password_hash, plain)
        except VerifyMismatchError:
            return False
        except Exception:
            return False
    if settings.admin_password:
        return secrets.compare_digest(plain, settings.admin_password)
    return False


def too_many_attempts(ip: str) -> bool:
    now = time.time()
    hits = [t for t in _attempts[ip] if now - t < WINDOW]
    _attempts[ip] = hits
    return len(hits) >= LIMIT


def register_attempt(ip: str) -> None:
    _attempts[ip].append(time.time())


def issue_session(response, user: str) -> str:
    token = _serializer.dumps({"u": user})
    csrf = secrets.token_urlsafe(24)
    max_age = settings.session_hours * 3600
    response.set_cookie(COOKIE_SESSION, token, max_age=max_age, httponly=True, samesite="lax")
    response.set_cookie(COOKIE_CSRF, csrf, max_age=max_age, httponly=False, samesite="lax")
    return csrf


def current_user(request: Request) -> str | None:
    raw = request.cookies.get(COOKIE_SESSION)
    if not raw:
        return None
    try:
        data = _serializer.loads(raw, max_age=settings.session_hours * 3600)
    except BadSignature:
        return None
    except Exception:
        return None
    return data.get("u")


def require_user(request: Request) -> str:
    user = current_user(request)
    if not user:
        raise HTTPException(status_code=status.HTTP_303_SEE_OTHER, headers={"Location": "/login"})
    return user


def check_csrf(request: Request, form_token: str | None) -> None:
    cookie = request.cookies.get(COOKIE_CSRF)
    if not cookie or not form_token or not secrets.compare_digest(cookie, form_token):
        raise HTTPException(status_code=400, detail="CSRF token mismatch")
