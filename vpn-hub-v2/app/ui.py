"""Шаблоны и фильтры для интерфейса."""

from __future__ import annotations

from datetime import datetime, timezone
from pathlib import Path

from fastapi.templating import Jinja2Templates

from .config import settings
from .models import KIND_LABELS
from .security import mask

TEMPLATES_DIR = Path(__file__).parent / "templates"
templates = Jinja2Templates(directory=str(TEMPLATES_DIR))


def fmt_bytes(value: int | None) -> str:
    if not value:
        return "0"
    size = float(value)
    for unit in ("Б", "КБ", "МБ", "ГБ", "ТБ"):
        if size < 1024 or unit == "ТБ":
            return f"{size:.0f} {unit}" if unit in ("Б", "КБ") else f"{size:.1f} {unit}"
        size /= 1024
    return f"{size:.1f} ТБ"


def fmt_dt(value: datetime | None) -> str:
    if not value:
        return "—"
    moment = value if value.tzinfo else value.replace(tzinfo=timezone.utc)
    return moment.strftime("%d.%m.%Y")


def fmt_days(days: int | None) -> str:
    if days is None:
        return "без срока"
    if days < 0:
        return "срок истёк"
    if days == 0:
        return "последний день"
    word = "день" if days % 10 == 1 and days % 100 != 11 else (
        "дня" if days % 10 in (2, 3, 4) and days % 100 not in (12, 13, 14) else "дней")
    return f"осталось {days} {word}"


def status_text(status: str, days: int | None) -> str:
    if status == "dead":
        return "Мёртвый"
    if status == "unknown":
        return "Не проверен"
    if days is not None and days <= 3:
        return f"Живой · {fmt_days(days)}"
    return "Живой"


templates.env.filters.update({
    "bytes": fmt_bytes,
    "dt": fmt_dt,
    "days": fmt_days,
    "mask": mask,
    "kind": lambda kind: KIND_LABELS.get(kind, kind),
})
templates.env.globals.update({
    "settings": settings,
    "status_text": status_text,
    "kind_labels": KIND_LABELS,
})
