"""Точка входа VPN Hub."""

from __future__ import annotations

import asyncio
import contextlib
import secrets
from contextlib import asynccontextmanager

from fastapi import FastAPI, Request
from fastapi.responses import PlainTextResponse, RedirectResponse
from fastapi.staticfiles import StaticFiles
from sqlalchemy import select

from .config import settings
from .db import SessionLocal, init_db
from .models import Event, Setting
from .routers import api, remna, servers, ui
from .services import detector, subscription, sync


def _bootstrap() -> None:
    init_db()
    db = SessionLocal()
    try:
        if not db.get(Setting, "mode"):
            db.add(Setting(key="mode", value=subscription.MODE_NORMAL))
            db.commit()
    finally:
        db.close()


async def _scheduler() -> None:
    """Пересборка раз в N часов, как в ТЗ."""
    interval = max(1, settings.sync_interval_hours) * 3600
    while True:
        await asyncio.sleep(interval)
        db = SessionLocal()
        try:
            row = db.get(Setting, "mode")
            mode = row.value if row else subscription.MODE_NORMAL
        finally:
            db.close()
        try:
            await sync.run_sync(mode=mode)
        except Exception as exc:  # noqa: BLE001
            print(f"[scheduler] sync failed: {exc}", flush=True)


@asynccontextmanager
async def lifespan(app: FastAPI):
    _bootstrap()
    for warning in settings.warnings():
        print(f"[warn] {warning}", flush=True)
    task = asyncio.create_task(_scheduler())
    detector_task = asyncio.create_task(detector.loop()) if settings.detector_enabled else None
    try:
        yield
    finally:
        task.cancel()
        if detector_task:
            detector_task.cancel()
        with contextlib.suppress(asyncio.CancelledError):
            await task


app = FastAPI(title=settings.app_name, lifespan=lifespan)
app.include_router(ui.router)
app.include_router(api.router)
app.include_router(remna.router)
app.include_router(servers.router)


@app.get("/healthz", response_class=PlainTextResponse)
def healthz() -> str:
    return "ok"


@app.get("/sub/{token}", response_class=PlainTextResponse)
def public_subscription(token: str, request: Request):
    """Итоговая подписка для Happ. Ссылка = токен из .env."""
    if not settings.sub_token or not secrets.compare_digest(token, settings.sub_token):
        return PlainTextResponse("not found", status_code=404)

    db = SessionLocal()
    try:
        row = db.get(Setting, "mode")
        mode = row.value if row else subscription.MODE_NORMAL
        payload, count = subscription.build(db, mode)
        info = subscription.userinfo_header(db)
    finally:
        db.close()

    if not count:
        return PlainTextResponse("empty", status_code=503)
    return PlainTextResponse(payload, headers={
        "subscription-userinfo": info,
        "profile-title": "VPN Hub",
        "profile-update-interval": str(max(1, settings.sync_interval_hours)),
        "profile-web-page-url": settings.public_base_url,
        "cache-control": "no-store",
    })



