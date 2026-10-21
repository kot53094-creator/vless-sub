"""«Обновить всё»: скачать, проверить, убрать мёртвые, пересобрать."""

from __future__ import annotations

import asyncio
import secrets
import threading
from datetime import datetime, timedelta, timezone

from sqlalchemy import select

from ..config import settings
from ..db import SessionLocal
from ..models import Event, NodeKey, Source, utcnow
from . import notifier
from .builder import build
from .bus import bus
from .checker import check_key
from .parser import parse_subscription, parse_userinfo, parse_uri
from .sources import fetch_subscription

MAX_CHECKS_PER_RUN = 120


def _log(run_id: str, text: str) -> None:
    bus.publish(run_id, text)


def _notify(text: str) -> None:
    """Уведомление из рабочего потока: свой цикл, чтобы не зависеть от SSE."""
    if not notifier.enabled():
        return
    try:
        asyncio.run(notifier.send(text))
    except RuntimeError:
        pass


def _refresh_source(db, source: Source, run_id: str, force: bool) -> tuple[bool, bool]:
    """Возвращает (alive, status_changed)."""
    was_alive = source.status == "alive"
    _log(run_id, f"· {source.name}")

    if source.url.lower().startswith(("http://", "https://")):
        stale = (
            force
            or source.last_fetch_at is None
            or utcnow() - source.last_fetch_at.replace(tzinfo=timezone.utc)
            > timedelta(hours=settings.fetch_interval_hours)
        )
        if stale:
            try:
                body, info = fetch_subscription(source.url, source.hwid or "vpnhub")
                source.last_fetch_at = utcnow()
                if info.get("total"):
                    source.traffic_total = info["total"]
                if info.get("download"):
                    source.traffic_used = info["download"]
                if info.get("expire"):
                    source.expires_at = datetime.fromtimestamp(info["expire"], tz=timezone.utc)
                _sync_keys(db, source, body, run_id)
            except Exception as exc:  # noqa: BLE001 - сеть бывает разной
                source.last_error = f"подписка не скачалась: {exc}"[:300]
                _log(run_id, f"  ошибка загрузки: {source.last_error}")

    keys = db.execute(select(NodeKey).where(NodeKey.source_id == source.id)).scalars().all()
    checked = 0
    for key in keys:
        if checked >= MAX_CHECKS_PER_RUN:
            break
        parsed = parse_uri(key.uri)
        if not parsed:
            continue
        result = check_key(parsed, settings.check_timeout)
        key.alive = result.alive
        key.latency_ms = result.latency_ms
        key.last_error = result.error[:200]
        key.last_check_at = utcnow()
        checked += 1

    alive_keys = [key for key in keys if key.alive]
    source.status = "alive" if alive_keys else "dead"
    source.latency_ms = min((k.latency_ms for k in alive_keys if k.latency_ms), default=None)
    source.last_check_at = utcnow()
    if alive_keys:
        source.last_error = ""

    changed = was_alive != (source.status == "alive")
    if changed and source.status == "dead":
        db.add(Event(level="error", kind="source_down", message=f"Источник «{source.name}» не отвечает"))
        _notify(notifier.source_down(source.name))
    return source.status == "alive", changed


def _sync_keys(db, source: Source, body: str, run_id: str) -> None:
    parsed = parse_subscription(body)
    existing = {k.fingerprint for k in db.execute(
        select(NodeKey).where(NodeKey.source_id == source.id)
    ).scalars()}
    added = 0
    for key in parsed:
        if key.fingerprint in existing:
            continue
        db.add(NodeKey(
            source_id=source.id, uri=key.uri, proto=key.proto, host=key.host, port=key.port,
            remark=key.remark[:200], security=key.security, fingerprint=key.fingerprint,
            alive=None, last_check_at=None,
        ))
        added += 1
    if added:
        _log(run_id, f"  новых ключей: {added}")


def run_refresh(trigger: str = "manual", run_id: str | None = None) -> dict:
    """Полный прогон. Можно звать из потока и из планировщика."""
    run_id = run_id or secrets.token_hex(8)
    db = SessionLocal()
    summary = {"alive": 0, "dead": 0, "keys": 0, "run_id": run_id}
    try:
        _log(run_id, "Начинаю обновление")
        sources = db.execute(select(Source).order_by(Source.id)).scalars().all()
        if not sources:
            _log(run_id, "Источников нет — добавьте ссылку или ключ")
            bus.finish(run_id, "0 0 0")
            return summary

        for source in sources:
            alive, _ = _refresh_source(db, source, run_id, force=(trigger == "manual"))
            summary["alive" if alive else "dead"] += 1
            db.commit()

        _, keys = build(db)
        summary["keys"] = keys
        db.add(Event(level="info", kind="sync", message=f"Обновление: живых {summary['alive']}, мёртвых {summary['dead']}, ключей {keys}"))
        db.commit()

        _log(run_id, f"Готово: живых источников {summary['alive']}, мёртвых {summary['dead']}")
        _log(run_id, f"В подписке ключей: {keys}")
        bus.finish(run_id, f"{summary['alive']} {summary['dead']} {keys}")
        _notify(notifier.sync_done(summary["alive"], summary["dead"], keys))
        return summary
    except Exception as exc:  # noqa: BLE001
        _log(run_id, f"Остановился с ошибкой: {exc}")
        bus.finish(run_id, "0 0 0")
        return summary
    finally:
        db.close()


def start_refresh(trigger: str = "manual") -> str:
    run_id = secrets.token_hex(8)
    threading.Thread(target=run_refresh, args=(trigger, run_id), daemon=True).start()
    return run_id


def check_deadlines(db) -> list[str]:
    """За 3 дня и в день окончания — одно сообщение в сутки на источник."""
    from ..models import Setting

    sent: list[str] = []
    today = utcnow().date().isoformat()
    for source in db.execute(select(Source)).scalars():
        days = source.days_left
        if days is None or days not in (3, 0):
            continue
        key = f"notified:{source.id}:{days}:{today}"
        if db.get(Setting, key):
            continue
        db.merge(Setting(key=key, value="1"))
        db.add(Event(level="warn", kind="source_expiring", message=f"«{source.name}»: осталось {days} дн."))
        sent.append(notifier.source_expiring(source.name, days))
    db.commit()
    for text in sent:
        if notifier.enabled():
            try:
                asyncio.run(notifier.send(text))
            except RuntimeError:
                pass
    return sent
