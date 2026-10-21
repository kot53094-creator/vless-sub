"""Уведомления в Telegram.

Если токен не задан — сообщения просто не отправляются, хаб продолжает
работать. Ошибки сети не пробрасываются наверх: уведомление не должно
ломать синхронизацию.

chat_id берётся из .env, а если там пусто — из базы: бот сам запоминает
чат, из которого ему написали (кнопка «Проверить бота» в настройках).
"""

from __future__ import annotations

import html

import httpx

from ..config import settings

API = "https://api.telegram.org/bot{token}/{method}"


def enabled() -> bool:
    return bool(settings.telegram_token and _chat_id())


def _chat_id() -> str:
    if settings.telegram_chat:
        return settings.telegram_chat
    try:
        from ..db import SessionLocal
        from ..models import Setting

        db = SessionLocal()
        try:
            row = db.get(Setting, "telegram_chat_id")
            return row.value if row and row.value else ""
        finally:
            db.close()
    except Exception:  # noqa: BLE001 - база может быть ещё не готова
        return ""


def chat_id() -> str:
    """Публичный доступ к найденному chat_id (для экрана настроек)."""
    return _chat_id()


def _esc(text: str | None) -> str:
    return html.escape(str(text or ""))


def _payload(text: str) -> dict:
    return {
        "chat_id": _chat_id(),
        "text": text[:4000],
        "parse_mode": "HTML",
        "disable_web_page_preview": True,
    }


async def send(text: str, transport=None) -> bool:
    """Отправить сообщение. True — принято Telegram."""
    if not enabled():
        return False
    url = API.format(token=settings.telegram_token, method="sendMessage")
    try:
        async with httpx.AsyncClient(timeout=15, transport=transport) as client:
            resp = await client.post(url, json=_payload(text))
            return resp.status_code == 200
    except httpx.HTTPError:
        return False


async def api_call(method: str, transport=None, **params) -> dict | None:
    """Произвольный вызов Bot API (getMe, getUpdates)."""
    if not settings.telegram_token:
        return None
    url = API.format(token=settings.telegram_token, method=method)
    try:
        async with httpx.AsyncClient(timeout=20, transport=transport) as client:
            resp = await client.get(url, params=params) if params else await client.get(url)
            if resp.status_code != 200:
                return None
            return resp.json()
    except httpx.HTTPError:
        return None


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
        parts = [_esc(name)]
        if days is not None:
            parts.append(f"осталось {days} дн.")
        if pct is not None:
            parts.append(f"трафик {pct}%")
        lines.append("• " + " · ".join(parts))
    return "\n".join(lines)


def format_source_expiry(name: str, days: int, kind: str) -> str:
    when = "сегодня" if days <= 0 else f"через {days} дн."
    return (
        f"<b>VPN Hub · ключ заканчивается</b>\n"
        f"{_esc(name)} [{_esc(kind)}] истекает <b>{when}</b>.\n"
        f"Продлите его или добавьте новый — иначе узел выпадет из подписки."
    )


def format_server_rent(name: str, days: int) -> str:
    when = "сегодня" if days <= 0 else f"через {days} дн."
    return (
        f"<b>VPN Hub · аренда сервера</b>\n"
        f"{_esc(name)}: оплата заканчивается <b>{when}</b>.\n"
        "Продлите аренду или перенесите ноду кнопкой «Создать на новом сервере»."
    )


def format_traffic_full(name: str, used: int | None, total: int | None) -> str:
    used_gb = (used or 0) / 1024 ** 3
    total_gb = (total or 0) / 1024 ** 3
    tail = f" из {total_gb:.1f} ГБ" if total else ""
    return (
        f"<b>VPN Hub · трафик исчерпан</b>\n"
        f"{_esc(name)}: {used_gb:.1f} ГБ{tail} — лимит выбран."
    )


def format_device(user: str, model: str, ip: str = "", country: str = "") -> str:
    extra = " · ".join(part for part in (ip, country) if part)
    return (
        f"<b>VPN Hub · новое устройство</b>\n"
        f"Ключ {_esc(user)}: {_esc(model)}"
        + (f"\n{_esc(extra)}" if extra else "")
    )


def format_node_down(name: str, detail: str = "") -> str:
    return (
        f"<b>VPN Hub · нода недоступна</b>\n"
        f"{_esc(name)} перестала отвечать."
        + (f"\n{_esc(detail)}" if detail else "")
    )


def format_remnawave_nodes(offline: list[str]) -> str:
    return (
        "<b>VPN Hub · Remnawave</b>\n"
        "Не на связи: " + ", ".join(_esc(name) for name in offline)
    )
