"""Уведомления в Telegram.

Если токен или chat_id не заданы — сообщения просто не отправляются,
хаб продолжает работать. Ошибки сети не пробрасываются наверх: уведомление
не должно ломать синхронизацию.
"""

from __future__ import annotations

import html

import httpx

from ..config import settings

API = "https://api.telegram.org/bot{token}/sendMessage"


def enabled() -> bool:
    return bool(settings.telegram_token and settings.telegram_chat)


def _payload(text: str) -> dict:
    return {
        "chat_id": settings.telegram_chat,
        "text": text[:4000],
        "parse_mode": "HTML",
        "disable_web_page_preview": True,
    }


async def send(text: str, transport=None) -> bool:
    """Отправить сообщение. True — принято Telegram."""
    if not enabled():
        return False
    url = API.format(token=settings.telegram_token)
    try:
        async with httpx.AsyncClient(timeout=15, transport=transport) as client:
            resp = await client.post(url, json=_payload(text))
            return resp.status_code == 200
    except httpx.HTTPError:
        return False


def format_sync(summary: dict) -> str:
    return (
        "<b>VPN Hub · синхронизация</b>\n"
        f"Опубликовано: <b>{summary.get('published', 0)}</b> узлов\n"
        f"Живых: {summary.get('alive', 0)} · источников с ошибкой: {summary.get('dead_sources', 0)}\n"
        f"Время: {summary.get('seconds', 0)} с"
    )


def format_mode(mode: str, ru_ok: bool, foreign_ok: bool) -> str:
    title = "белые списки" if mode == "whitelist" else "обычный режим"
    return (
        f"<b>VPN Hub · режим сети</b>\nПереключено на <b>{title}</b>\n"
        f"Российский сайт: {'открывается' if ru_ok else 'не открывается'}\n"
        f"Зарубежный сайт: {'открывается' if foreign_ok else 'не открывается'}"
    )


def format_expiring(items: list[tuple[str, int | None, int | None]]) -> str:
    """items: (имя, дней осталось, процент трафика)."""
    lines = ["<b>VPN Hub · скоро закончится</b>"]
    for name, days, pct in items:
        parts = [html.escape(name)]
        if days is not None:
            parts.append(f"осталось {days} дн.")
        if pct is not None:
            parts.append(f"трафик {pct}%")
        lines.append("• " + " · ".join(parts))
    return "\n".join(lines)
