"""Точка входа VPN Hub."""

from __future__ import annotations

import asyncio
import contextlib
import secrets
from contextlib import asynccontextmanager

from fastapi import FastAPI, Request
from fastapi.responses import JSONResponse, PlainTextResponse, RedirectResponse
from fastapi.staticfiles import StaticFiles
from sqlalchemy import select

from .config import settings
from .db import SessionLocal, init_db
from .models import Event, Setting
from .routers import api, remna, routing as routing_router, servers, ui
from .services import deadlines, detector, routing, subscription, sync


def _bootstrap() -> None:
    init_db()
    db = SessionLocal()
    try:
        if not db.get(Setting, "mode"):
            db.add(Setting(key="mode", value=subscription.MODE_NORMAL))
            db.commit()
        # Правила маршрутизации по умолчанию — один раз, дальше правятся на экране.
        routing.seed_defaults(db)
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


async def _deadline_loop() -> None:
    """Раз в час: сроки ключей и аренды, исчерпанный трафик."""
    interval = max(300, settings.deadline_check_minutes * 60)
    while True:
        await asyncio.sleep(interval)
        try:
            await deadlines.scan()
        except Exception as exc:  # noqa: BLE001 - напоминания не должны ронять хаб
            print(f"[deadlines] {type(exc).__name__}: {exc}", flush=True)


@asynccontextmanager
async def lifespan(app: FastAPI):
    _bootstrap()
    for warning in settings.warnings():
        print(f"[warn] {warning}", flush=True)
    task = asyncio.create_task(_scheduler()) if settings.scheduler_enabled else None
    detector_task = asyncio.create_task(detector.loop()) if settings.detector_enabled else None
    deadline_task = asyncio.create_task(_deadline_loop())
    if task is None:
        print("[info] встроенный планировщик выключен (HUB_SCHEDULER_ENABLED=0): "
              "синхронизацию должен запускать systemd-таймер или cron", flush=True)
    try:
        yield
    finally:
        if task:
            task.cancel()
        if detector_task:
            detector_task.cancel()
        deadline_task.cancel()
        if task:
            with contextlib.suppress(asyncio.CancelledError):
                await task


app = FastAPI(title=settings.app_name, lifespan=lifespan)
app.include_router(ui.router)
app.include_router(api.router)
app.include_router(remna.router)
app.include_router(servers.router)
app.include_router(routing_router.router)


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
        # Не стандарт, но полезно: клиент или скрипт может найти профиль правил.
        "routing-profile-url": f"{settings.public_base_url}/sub/{settings.sub_token}/routing",
        "cache-control": "no-store",
    })


@app.get("/sub/{token}/routing")
def public_routing(token: str):
    """Профиль маршрутизации для Happ: правила sing-box по тому же токену."""
    if not settings.sub_token or not secrets.compare_digest(token, settings.sub_token):
        return PlainTextResponse("not found", status_code=404)

    db = SessionLocal()
    try:
        row = db.get(Setting, "mode")
        mode = row.value if row else subscription.MODE_NORMAL
        payload = routing.build_profile(db, mode)
    finally:
        db.close()

    return JSONResponse(payload, headers={
        "profile-title": "VPN Hub routing",
        "cache-control": "no-store",
    })



