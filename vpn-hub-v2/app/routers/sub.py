"""Публичная ссылка подписки для Happ."""

from __future__ import annotations

import secrets

from fastapi import APIRouter, Depends, Request
from fastapi.responses import PlainTextResponse
from sqlalchemy.orm import Session

from ..config import settings
from ..db import get_db
from ..models import Setting
from ..services.builder import build, get_mode, userinfo

router = APIRouter()


def _rate_ok(request: Request) -> bool:
    from ..security import mem_rate
    ip = request.client.host if request.client else "?"
    return mem_rate(f"sub:{ip}", 120, 60)


@router.get("/sub/{token}")
def subscription(token: str, request: Request, db: Session = Depends(get_db)):
    if not _rate_ok(request):
        return PlainTextResponse("Слишком много запросов", status_code=429)

    row = db.get(Setting, "sub_token")
    expected = (row.value if row else "") or settings.sub_token
    if not expected or not secrets.compare_digest(token, expected):
        # Чужой токен не должен отличаться от «пустой» подписки.
        return PlainTextResponse("", status_code=404)

    mode = get_mode(db)
    body, count = build(db, mode)
    headers = {
        "subscription-userinfo": userinfo(db),
        "profile-update-interval": str(max(1, settings.fetch_interval_hours)),
        "profile-title": "VPN Hub",
        "cache-control": "no-store",
    }
    if not count:
        return PlainTextResponse("", status_code=200, headers=headers)
    return PlainTextResponse(body, headers=headers)
