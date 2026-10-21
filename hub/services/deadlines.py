"""Дедлайны и пороги: срок ключей, аренда серверов, исчерпанный трафик.

Каждое предупреждение уходит не чаще раза в сутки на объект — для этого
таблица `notifications_sent`.
"""

from __future__ import annotations

from sqlalchemy import select
from sqlalchemy.orm import Session

from ..db import SessionLocal
from ..models import NotificationSent, Server, Source, utcnow
from . import notifier

# за сколько дней предупреждать
EXPIRY_DAYS = (3, 1, 0)
TRAFFIC_PCT = 100


def _already(db: Session, kind: str, ref: str, bucket: str) -> bool:
    return db.execute(
        select(NotificationSent.id).where(
            NotificationSent.kind == kind,
            NotificationSent.ref == ref,
            NotificationSent.bucket == bucket,
        )
    ).first() is not None


def _mark(db: Session, kind: str, ref: str, bucket: str) -> None:
    db.add(NotificationSent(kind=kind, ref=str(ref)[:60], bucket=bucket))


def _days_left(moment) -> int | None:
    if not moment:
        return None
    now = utcnow()
    if moment.tzinfo is None:
        from datetime import timezone

        moment = moment.replace(tzinfo=timezone.utc)
    return (moment - now).days


async def scan(notify: bool = True) -> list[str]:
    """Проверяет сроки и возвращает список отправленных сообщений."""
    db = SessionLocal()
    sent: list[str] = []
    try:
        bucket = utcnow().date().isoformat()

        for src in db.execute(select(Source).where(Source.status != "disabled")).scalars():
            days = src.days_left
            if days is not None and days in EXPIRY_DAYS:
                kind, ref = "source_expiry", f"source:{src.id}"
                if not _already(db, kind, ref, bucket):
                    text = notifier.format_source_expiry(src.name, days, src.kind)
                    if notify:
                        await notifier.send(text)
                    _mark(db, kind, ref, bucket)
                    sent.append(text)

            pct = src.traffic_pct
            if pct is not None and pct >= TRAFFIC_PCT:
                kind, ref = "source_traffic", f"source:{src.id}"
                if not _already(db, kind, ref, bucket):
                    text = notifier.format_traffic_full(src.name, src.used_bytes,
                                                        src.total_bytes or src.traffic_limit)
                    if notify:
                        await notifier.send(text)
                    _mark(db, kind, ref, bucket)
                    sent.append(text)

        for srv in db.execute(select(Server)).scalars():
            days = _days_left(srv.rent_until)
            if days is not None and days in EXPIRY_DAYS:
                kind, ref = "server_rent", f"server:{srv.id}"
                if not _already(db, kind, ref, bucket):
                    text = notifier.format_server_rent(srv.name, days)
                    if notify:
                        await notifier.send(text)
                    _mark(db, kind, ref, bucket)
                    sent.append(text)

        db.commit()
    finally:
        db.close()
    return sent
