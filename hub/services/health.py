"""История проверок источников: доступность за 7 дней."""

from __future__ import annotations

from collections import defaultdict
from datetime import timedelta

from sqlalchemy import select
from sqlalchemy.orm import Session

from ..models import CheckEvent, utcnow


def record(db: Session, source_id: int, ok: bool, latency_ms: int | None = None,
           error: str = "") -> None:
    db.add(CheckEvent(source_id=source_id, ok=bool(ok), latency_ms=latency_ms,
                      error=(error or "")[:300]))


def seven_days(db: Session, days: int = 7, source_ids: list[int] | None = None) -> dict[int, list[dict]]:
    """source_id → список из `days` дней: {date, pct, ok, label}."""
    today = utcnow().date()
    window = [today - timedelta(days=offset) for offset in range(days - 1, -1, -1)]
    since = utcnow() - timedelta(days=days)

    stmt = select(CheckEvent).where(CheckEvent.ts >= since)
    if source_ids:
        stmt = stmt.where(CheckEvent.source_id.in_(source_ids))
    rows = db.execute(stmt).scalars().all()

    buckets: dict[int, dict] = defaultdict(lambda: defaultdict(list))
    for row in rows:
        day = row.ts.date() if row.ts else today
        buckets[row.source_id][day].append(bool(row.ok))

    out: dict[int, list[dict]] = {}
    for source_id, by_day in buckets.items():
        series: list[dict] = []
        for day in window:
            marks = by_day.get(day)
            if not marks:
                series.append({"date": day, "pct": None, "ok": None, "label": "нет данных"})
            else:
                pct = round(100 * sum(1 for m in marks if m) / len(marks))
                series.append({"date": day, "pct": pct, "ok": pct >= 50,
                               "label": f"{day:%d.%m}: {pct}%"})
        out[source_id] = series
    return out


def availability(db: Session, source_id: int, days: int = 7) -> int | None:
    """Средняя доступность за период, % (None — проверок не было)."""
    since = utcnow() - timedelta(days=days)
    rows = db.execute(
        select(CheckEvent).where(CheckEvent.source_id == source_id, CheckEvent.ts >= since)
    ).scalars().all()
    if not rows:
        return None
    return round(100 * sum(1 for row in rows if row.ok) / len(rows))
