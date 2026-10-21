"""Сборка итоговой подписки: порядок, дедупликация, приватность."""

from __future__ import annotations

from sqlalchemy import select
from sqlalchemy.orm import Session

from ..models import NodeKey, Setting, Source
from .parser import to_base64, with_label

MODE_NORMAL = "normal"
MODE_WHITELIST = "whitelist"

ORDER = {
    MODE_NORMAL: {"own_vps": 0, "trial": 1, "public": 2, "paid_private": 99},
    MODE_WHITELIST: {"own_vps": 1, "trial": 2, "public": 3, "paid_private": 99},
}


def get_mode(db: Session) -> str:
    row = db.get(Setting, "mode")
    return row.value if row and row.value in ORDER else MODE_NORMAL


def set_mode(db: Session, mode: str) -> None:
    row = db.get(Setting, "mode") or Setting(key="mode")
    row.value = mode if mode in ORDER else MODE_NORMAL
    db.merge(row)


def is_deliverable(source: Source) -> bool:
    """Платное личное и всё помеченное private не отдаём никому и никогда."""
    if source.kind == "paid_private":
        return False
    if source.visibility == "private":
        return False
    if source.status == "dead":
        return False
    return True


def deliverable_keys(db: Session, mode: str | None = None) -> list[tuple[Source, NodeKey]]:
    mode = mode or get_mode(db)
    order = ORDER.get(mode, ORDER[MODE_NORMAL])
    rows = db.execute(
        select(NodeKey, Source).join(Source, Source.id == NodeKey.source_id)
    ).all()

    picked: list[tuple[Source, NodeKey]] = []
    seen: set[str] = set()
    for key, source in rows:
        if key.alive is not True:
            continue
        if not is_deliverable(source):
            continue
        if key.fingerprint in seen:
            continue
        seen.add(key.fingerprint)
        picked.append((source, key))

    picked.sort(key=lambda item: (
        order.get(item[0].kind, 50),
        item[1].latency_ms if item[1].latency_ms is not None else 9999,
        item[1].id,
    ))
    return picked


def build(db: Session, mode: str | None = None) -> tuple[str, int]:
    mode = mode or get_mode(db)
    lines: list[str] = []
    for source, key in deliverable_keys(db, mode):
        label = f"{source.name} · {key.proto.upper()}"
        lines.append(with_label(key.uri, label[:120]))
    return to_base64(lines), len(lines)


def userinfo(db: Session) -> str:
    """Трафик и срок по своим нодам: их реально видно в панели."""
    sources = db.execute(select(Source).where(Source.kind == "own_vps")).scalars().all()
    used = sum(src.traffic_used or 0 for src in sources)
    total = sum(src.traffic_total or 0 for src in sources)
    deadlines = [src.deadline for src in sources if src.deadline]
    expire = int(min(deadlines).timestamp()) if deadlines else 0
    return f"upload=0; download={used}; total={total}; expire={expire}"
