"""Точка входа: сайт, подписка, планировщик, детектор."""

from __future__ import annotations

import asyncio
import contextlib
from contextlib import asynccontextmanager
from pathlib import Path

from fastapi import FastAPI
from fastapi.staticfiles import StaticFiles
from starlette.middleware.sessions import SessionMiddleware

from .config import settings
from .db import SessionLocal, init_db
from .routers import pages, sub
from .services import detector, sync
from .services.bus import bus


async def _scheduler() -> None:
    """Обновление раз в N часов и проверка сроков раз в час."""
    interval = max(1, settings.fetch_interval_hours) * 3600
    while True:
        await asyncio.sleep(interval)
        await asyncio.to_thread(sync.run_refresh, "timer")
        db = SessionLocal()
        try:
            sync.check_deadlines(db)
        finally:
            db.close()


@asynccontextmanager
async def lifespan(app: FastAPI):
    init_db()
    bus.bind_loop(asyncio.get_running_loop())
    tasks = [asyncio.create_task(_scheduler())]
    if settings.detector_enabled:
        tasks.append(asyncio.create_task(detector.loop()))
    try:
        yield
    finally:
        for task in tasks:
            task.cancel()
        for task in tasks:
            with contextlib.suppress(asyncio.CancelledError):
                await task


app = FastAPI(title="VPN Hub", lifespan=lifespan)
app.add_middleware(
    SessionMiddleware,
    secret_key=settings.secret_key,
    session_cookie="vpnhub_session",
    max_age=72 * 3600,
    same_site="lax",
    https_only=settings.app_url.startswith("https://"),
)

STATIC = Path(__file__).parent / "static"
app.mount("/static", StaticFiles(directory=str(STATIC)), name="static")

app.include_router(pages.router)
app.include_router(sub.router)


@app.get("/healthz")
def healthz():
    return {"ok": True}
