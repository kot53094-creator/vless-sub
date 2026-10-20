"""Сборка итоговой подписки для Happ.

Порядок:
  обычный режим   — own_vps → trial → public
  белые списки    — bridge_ru → cdn_xhttp → own_vps → trial → public
Публичные источники помечаются тегом, чтобы не заходить через них в банки.
"""

from __future__ import annotations

import base64
from urllib.parse import quote

from sqlalchemy import select
from sqlalchemy.orm import Session

from ..models import Node, Source

MODE_NORMAL = "normal"
MODE_WHITELIST = "whitelist"

ORDER_NORMAL = ["own_vps", "trial", "public"]
ORDER_WHITELIST = ["bridge_ru", "cdn_xhttp", "own_vps", "trial", "public"]

COLORS = {
    "own_vps": "🟢",
    "trial": "🟠",
    "public": "⚪",
    "bridge_ru": "🔵",
    "cdn_xhttp": "🟣",
}


def order_for(mode: str) -> list[str]:
    return ORDER_WHITELIST if mode == MODE_WHITELIST else ORDER_NORMAL


def _label(rec: Node, src: Source) -> str:
    base = rec.remark or f"{rec.host}:{rec.port}"
    tag = f"{COLORS.get(src.kind, '⚪')} {src.name}"
    if src.kind == "public":
        tag += " · не для банков"
    return f"{tag} | {base}"


def with_label(uri: str, label: str) -> str:
    head = uri.split("#", 1)[0]
    return f"{head}#{quote(label, safe='')}"


def collect(db: Session, mode: str = MODE_NORMAL) -> list[tuple[Node, Source]]:
    """Живые узлы в нужном порядке."""
    rows = db.execute(
        select(Node, Source).join(Source, Node.source_id == Source.id)
        .where(Node.alive.is_(True), Source.status == "active")
    ).all()

    order = {kind: index for index, kind in enumerate(order_for(mode))}
    rows.sort(key=lambda pair: (
        order.get(pair[1].kind, 99),
        pair[1].priority,
        pair[0].latency_ms if pair[0].latency_ms is not None else 9999,
        pair[0].host,
    ))

    # Один и тот же сервер может прийти из нескольких подписок: в выдаче
    # он нужен один раз — оставляем то место, где он оказался выше.
    seen: set[str] = set()
    unique: list[tuple[Node, Source]] = []
    for pair in rows:
        key = pair[0].fingerprint or f"{pair[0].host}:{pair[0].port}"
        if key in seen:
            continue
        seen.add(key)
        unique.append(pair)
    return unique


def build(db: Session, mode: str = MODE_NORMAL) -> tuple[str, int]:
    """Возвращает (base64-подписка, количество узлов)."""
    rows = collect(db, mode)
    lines = [with_label(node.uri, _label(node, src)) for node, src in rows]
    raw = "\n".join(lines)
    encoded = base64.b64encode(raw.encode("utf-8")).decode("ascii")
    return encoded, len(lines)


def userinfo_header(db: Session) -> str:
    """Суммарный трафик по всем активным источникам для Happ."""
    rows = db.execute(select(Source).where(Source.status == "active")).scalars().all()
    total_used = sum(s.used_bytes or 0 for s in rows)
    totals = [s.total_bytes for s in rows if s.total_bytes]
    total_all = sum(totals) if totals else 0
    deadlines = [s.deadline for s in rows if s.deadline]
    expire = int(min(deadlines).timestamp()) if deadlines else 0
    return f"upload=0; download={total_used}; total={total_all}; expire={expire}"
