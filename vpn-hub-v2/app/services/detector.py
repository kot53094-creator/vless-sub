"""Режим «белые списки»: российский сайт открыт, зарубежный — нет."""

from __future__ import annotations

import asyncio

import httpx
from sqlalchemy import select

from ..config import settings
from ..db import SessionLocal
from ..models import Event, Probe, Setting
from . import notifier
from .builder import MODE_NORMAL, MODE_WHITELIST, get_mode, set_mode

BAD_STREAK_KEY = "detector_bad_streak"
GOOD_STREAK_KEY = "detector_good_streak"
BAD_THRESHOLD = 3
GOOD_THRESHOLD = 3


async def _probe(url: str, timeout: float) -> tuple[bool, int | None]:
    try:
        async with httpx.AsyncClient(timeout=timeout, follow_redirects=True) as client:
            response = await client.get(url, headers={"User-Agent": settings.fetch_ua})
            return response.status_code < 400, response.elapsed.microseconds // 1000
    except httpx.HTTPError:
        return False, None


def _bump(db, key: str, delta: int) -> int:
    row = db.get(Setting, key) or Setting(key=key, value="0")
    value = max(0, int(row.value or 0) + delta)
    row.value = str(value)
    db.merge(row)
    return value


async def probe_once() -> dict:
    ru_ok, ru_ms = await _probe(settings.probe_ru_url, 6)
    foreign_ok, foreign_ms = await _probe(settings.probe_foreign_url, 6)

    db = SessionLocal()
    try:
        mode_before = get_mode(db)
        blocked = ru_ok and not foreign_ok
        bad = _bump(db, BAD_STREAK_KEY, 1 if blocked else -99) if blocked else _bump(db, BAD_STREAK_KEY, -1)
        good = _bump(db, GOOD_STREAK_KEY, 0 if blocked else 1)

        mode = mode_before
        if bad >= BAD_THRESHOLD and mode_before != MODE_WHITELIST:
            set_mode(db, MODE_WHITELIST)
            mode = MODE_WHITELIST
        elif good >= GOOD_THRESHOLD and mode_before == MODE_WHITELIST:
            set_mode(db, MODE_NORMAL)
            mode = MODE_NORMAL

        db.add(Probe(ru_ok=ru_ok, foreign_ok=foreign_ok, mode=mode))
        if mode != mode_before:
            db.add(Event(level="warn", kind="mode", message=f"Режим сети: {mode}"))
            db.commit()
            if notifier.enabled():
                await notifier.send(notifier.mode_changed(mode, ru_ok, foreign_ok))
        else:
            db.commit()

        return {"ru_ok": ru_ok, "foreign_ok": foreign_ok, "mode": mode,
                "ru_ms": ru_ms, "foreign_ms": foreign_ms, "bad": bad}
    finally:
        db.close()


async def loop() -> None:
    while True:
        try:
            await probe_once()
        except Exception:  # noqa: BLE001 - детектор не должен падать
            pass
        await asyncio.sleep(max(60, settings.detector_interval))


def last_probe(db) -> Probe | None:
    return db.execute(select(Probe).order_by(Probe.ts.desc()).limit(1)).scalar_one_or_none()
