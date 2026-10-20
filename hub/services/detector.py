"""Детектор белых списков.

Логика простая и намеренно консервативная: режим «белые списки» включается,
только если российский сайт открывается, а зарубежный не открывается
`THRESHOLD` проверок подряд. Выключается, как только зарубежный снова
заработал. Ручной переключатель всегда важнее автоматики.
"""

from __future__ import annotations

import asyncio
import json
import time
from datetime import datetime, timezone

import httpx
from sqlalchemy import select

from ..config import settings
from ..db import SessionLocal
from ..models import Event, Setting
from . import notifier, subscription

THRESHOLD = 3

STATE_KEY = "detector"


class ProbeResult:
    __slots__ = ("ok", "latency_ms", "error")

    def __init__(self, ok: bool, latency_ms: int | None = None, error: str = "") -> None:
        self.ok = ok
        self.latency_ms = latency_ms
        self.error = error


async def probe(url: str, timeout: float = 8.0, transport=None) -> ProbeResult:
    """Доступность сайта: важно только «открылся / нет», тело не читаем."""
    started = time.perf_counter()
    try:
        async with httpx.AsyncClient(timeout=timeout, follow_redirects=True,
                                     transport=transport) as client:
            resp = await client.get(url)
            latency = int((time.perf_counter() - started) * 1000)
            return ProbeResult(resp.status_code < 400, latency)
    except httpx.HTTPError as exc:
        return ProbeResult(False, None, type(exc).__name__)


def decide(ru_ok: bool, foreign_ok: bool, fails: int, current_mode: str,
           threshold: int = THRESHOLD) -> tuple[int, str | None]:
    """Чистая функция решения: (новый счётчик, режим или None).

    Режим меняется только при переходе, чтобы не дёргать его каждые 5 минут.
    """
    if ru_ok and not foreign_ok:
        fails += 1
    else:
        fails = 0

    if fails >= threshold and current_mode != subscription.MODE_WHITELIST:
        return fails, subscription.MODE_WHITELIST
    if foreign_ok and current_mode == subscription.MODE_WHITELIST:
        return fails, subscription.MODE_NORMAL
    return fails, None


def load_state(db) -> dict:
    row = db.get(Setting, STATE_KEY)
    if not row or not row.value:
        return {"fails": 0, "ru_ok": None, "foreign_ok": None, "checked_at": None}
    try:
        return json.loads(row.value)
    except json.JSONDecodeError:
        return {"fails": 0, "ru_ok": None, "foreign_ok": None, "checked_at": None}


def save_state(db, state: dict) -> None:
    row = db.get(Setting, STATE_KEY) or Setting(key=STATE_KEY)
    row.value = json.dumps(state, ensure_ascii=False)
    db.merge(row)


def current_mode(db) -> str:
    row = db.get(Setting, "mode")
    return row.value if row else subscription.MODE_NORMAL


def set_mode(db, mode: str) -> None:
    row = db.get(Setting, "mode") or Setting(key="mode")
    row.value = mode
    db.merge(row)


async def check_once(notify: bool = True) -> dict:
    """Одна проверка. Возвращает состояние и признак переключения."""
    ru = await probe(settings.probe_ru_url)
    foreign = await probe(settings.probe_foreign_url)

    db = SessionLocal()
    try:
        state = load_state(db)
        mode = current_mode(db)
        fails, new_mode = decide(ru.ok, foreign.ok, int(state.get("fails") or 0), mode)

        state.update({
            "fails": fails,
            "ru_ok": ru.ok,
            "foreign_ok": foreign.ok,
            "ru_ms": ru.latency_ms,
            "foreign_ms": foreign.latency_ms,
            "checked_at": datetime.now(timezone.utc).isoformat(),
        })
        save_state(db, state)

        switched = None
        if new_mode and new_mode != mode:
            set_mode(db, new_mode)
            switched = new_mode
            label = "белые списки" if new_mode == subscription.MODE_WHITELIST else "обычный"
            db.add(Event(level="warn", message=f"Детектор переключил режим: {label}"))
        db.commit()

        if switched and notify:
            await notifier.send(notifier.format_mode(switched, ru.ok, foreign.ok))

        return {
            "ru_ok": ru.ok,
            "foreign_ok": foreign.ok,
            "ru_ms": ru.latency_ms,
            "foreign_ms": foreign.latency_ms,
            "fails": fails,
            "mode": switched or mode,
            "switched": bool(switched),
        }
    finally:
        db.close()


async def loop() -> None:
    """Фоновая проверка раз в HUB_DETECTOR_INTERVAL секунд."""
    interval = max(60, settings.detector_interval)
    while True:
        await asyncio.sleep(interval)
        try:
            await check_once()
        except Exception as exc:  # noqa: BLE001 - детектор не должен падать
            print(f"[detector] {type(exc).__name__}: {exc}", flush=True)


async def watch_new_device(devices_by_user: dict[str, int]) -> None:
    """Заготовка этапа уведомлений: сравнить число устройств с прошлым разом."""
    db = SessionLocal()
    try:
        row = db.get(Setting, "device_snapshot")
        previous = json.loads(row.value) if row and row.value else {}
        for user, count in devices_by_user.items():
            old = int(previous.get(user, count))
            if count > old:
                await notifier.send(
                    f"<b>VPN Hub · новое устройство</b>\nПользователь {user}: "
                    f"было {old}, стало {count}"
                )
        merged = {**previous, **{k: v for k, v in devices_by_user.items()}}
        snap = db.get(Setting, "device_snapshot") or Setting(key="device_snapshot")
        snap.value = json.dumps(merged)
        db.merge(snap)
        db.commit()
    finally:
        db.close()
