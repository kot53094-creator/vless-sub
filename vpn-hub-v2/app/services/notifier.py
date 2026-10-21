"""Уведомления в Telegram. Ошибки сети не ломают работу хаба."""

from __future__ import annotations

import html

import httpx

from ..config import settings

API = "https://api.telegram.org/bot{token}/sendMessage"


def enabled() -> bool:
    return bool(settings.bot_token and settings.admin_tg_id)


async def send(text: str) -> bool:
    if not enabled():
        return False
    payload = {
        "chat_id": settings.admin_tg_id,
        "text": text[:4000],
        "parse_mode": "HTML",
        "disable_web_page_preview": True,
    }
    try:
        async with httpx.AsyncClient(timeout=15) as client:
            response = await client.post(API.format(token=settings.bot_token), json=payload)
            return response.status_code == 200
    except httpx.HTTPError:
        return False


def _e(value: str) -> str:
    return html.escape(value or "")


def source_expiring(name: str, days: int) -> str:
    when = "сегодня" if days <= 0 else f"через {days} дн."
    return f"<b>Срок источника</b>\n{_e(name)} закончится {when}."


def source_down(name: str) -> str:
    return f"<b>Источник не отвечает</b>\n{_e(name)}. Откройте сайт и проверьте."


def mode_changed(mode: str, ru: bool, foreign: bool) -> str:
    title = "белые списки" if mode == "whitelist" else "обычный режим"
    return (f"<b>Режим сети: {title}</b>\n"
            f"Российский сайт: {'открыт' if ru else 'закрыт'}\n"
            f"Зарубежный сайт: {'открыт' if foreign else 'закрыт'}")


def sync_done(alive: int, dead: int, keys: int) -> str:
    return f"<b>Обновление готово</b>\nИсточников живых: {alive}, мёртвых: {dead}. Ключей в подписке: {keys}."
