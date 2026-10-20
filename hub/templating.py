"""Общие шаблоны и фильтры для интерфейса."""

from __future__ import annotations

from datetime import datetime, timezone
from pathlib import Path

from fastapi.templating import Jinja2Templates

BASE = Path(__file__).resolve().parent
templates = Jinja2Templates(directory=str(BASE / "templates"))


def fmt_bytes(value: int | None) -> str:
    if value is None:
        return "—"
    size = float(value)
    for unit in ("Б", "КБ", "МБ", "ГБ", "ТБ"):
        if size < 1024 or unit == "ТБ":
            return f"{size:.1f} {unit}".replace(".0 ", " ")
        size /= 1024
    return f"{size:.1f} ТБ"


def fmt_dt(value: datetime | None) -> str:
    if not value:
        return "—"
    if value.tzinfo is None:
        value = value.replace(tzinfo=timezone.utc)
    return value.astimezone().strftime("%d.%m.%Y %H:%M")


def mask_link(url: str, keep: int = 10) -> str:
    if len(url) <= keep * 2:
        return "•" * len(url)
    return f"{url[:keep]}…{url[-4:]}"


def fmt_iso(value) -> str:
    """ISO-строка из состояния детектора → «21.10.2026 13:05»."""
    if not value:
        return "—"
    try:
        moment = datetime.fromisoformat(str(value).replace("Z", "+00:00"))
    except ValueError:
        return str(value)
    if moment.tzinfo is None:
        moment = moment.replace(tzinfo=timezone.utc)
    return moment.astimezone().strftime("%d.%m.%Y %H:%M")


templates.env.filters["bytes"] = fmt_bytes
templates.env.filters["iso"] = fmt_iso
templates.env.filters["dt"] = fmt_dt
templates.env.filters["mask"] = mask_link
