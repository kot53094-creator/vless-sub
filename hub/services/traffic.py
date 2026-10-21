"""Трафик за сутки и за месяц по снимкам `used_bytes`.

Панели отдают только накопленный счётчик, поэтому при каждом прогоне
hub-sync пишем снимок, а расход считаем как разницу между текущим
значением и последним снимком до начала окна.
"""

from __future__ import annotations

from datetime import timedelta

from sqlalchemy import delete, select
from sqlalchemy.orm import Session

from ..models import Source, TrafficSample, utcnow

RETENTION_DAYS = 90


def record(db: Session, source_ids: list[int] | None = None) -> int:
    """Снимок текущих счётчиков. Возвращает число записей."""
    now = utcnow()
    stmt = select(Source)
    if source_ids is not None:
        stmt = stmt.where(Source.id.in_(source_ids))
    count = 0
    for src in db.execute(stmt).scalars():
        db.add(TrafficSample(ts=now, source_id=src.id, used_bytes=int(src.used_bytes or 0)))
        count += 1
    db.commit()
    return count


def _baseline(db: Session, source_id: int, since) -> int | None:
    """Счётчик на начало окна: последний снимок до `since` или первый после."""
    before = db.execute(
        select(TrafficSample)
        .where(TrafficSample.source_id == source_id, TrafficSample.ts <= since)
        .order_by(TrafficSample.ts.desc())
        .limit(1)
    ).scalar_one_or_none()
    if before:
        return int(before.used_bytes)
    after = db.execute(
        select(TrafficSample)
        .where(TrafficSample.source_id == source_id, TrafficSample.ts >= since)
        .order_by(TrafficSample.ts)
        .limit(1)
    ).scalar_one_or_none()
    return int(after.used_bytes) if after else None


def usage_since(db: Session, since) -> int:
    total = 0
    for src in db.execute(select(Source).where(Source.status != "disabled")).scalars():
        base = _baseline(db, src.id, since)
        if base is None:
            continue
        total += max(0, int(src.used_bytes or 0) - base)
    return total


def day_usage(db: Session) -> int:
    return usage_since(db, utcnow() - timedelta(days=1))


def month_usage(db: Session) -> int:
    return usage_since(db, utcnow() - timedelta(days=30))


def prune(db: Session, days: int = RETENTION_DAYS) -> None:
    db.execute(delete(TrafficSample).where(TrafficSample.ts < utcnow() - timedelta(days=days)))
    db.commit()
