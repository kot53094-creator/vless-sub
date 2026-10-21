"""Команды и кнопки бота."""

from __future__ import annotations

import asyncio
from aiogram import F, Router
from aiogram.filters import Command, CommandStart
from aiogram.fsm.context import FSMContext
from aiogram.fsm.state import State, StatesGroup
from aiogram.types import CallbackQuery, InlineKeyboardButton, InlineKeyboardMarkup, Message
from sqlalchemy import func, select

from ..config import settings
from ..db import SessionLocal
from ..models import NodeKey, Setting, Source
from ..services import notifier
from ..services.builder import MODE_NORMAL, MODE_WHITELIST, get_mode, set_mode
from ..services.detector import probe_once
from ..services.sources import add_lines
from ..services.sync import start_refresh
from .access import is_admin, rate_ok
from .texts import (
    DEVICE_TITLES,
    HELP,
    NO_ACCESS,
    NO_LINK,
    WELCOME,
    WELCOME_BUTTONS,
    device_menu,
    instruction,
)

router = Router()

class AddKey(StatesGroup):
    waiting = State()


def keyboard(rows: list[list[tuple[str, str]]] | None = None) -> InlineKeyboardMarkup:
    if rows is None:
        rows = list(WELCOME_BUTTONS)
        if settings.people_enabled:
            rows = [[("Пробный доступ", "p:trial"), ("Кабинет", "p:cabinet")]] + rows
    return InlineKeyboardMarkup(inline_keyboard=[
        [InlineKeyboardButton(text=label, callback_data=data) for label, data in row]
        for row in rows
    ])


def sub_link() -> str:
    return f"{settings.app_url}/sub/{settings.sub_token}"


def source_stats() -> tuple[int, int, int]:
    db = SessionLocal()
    try:
        alive = db.execute(select(func.count()).select_from(Source).where(Source.status == "alive")).scalar() or 0
        dead = db.execute(select(func.count()).select_from(Source).where(Source.status == "dead")).scalar() or 0
        keys = db.execute(select(func.count()).select_from(NodeKey).where(NodeKey.alive.is_(True))).scalar() or 0
        return alive, dead, keys
    finally:
        db.close()


async def _guard(event: Message | CallbackQuery) -> bool:
    """Один админ и лимит частоты: остальным не отвечаем вовсе."""
    user = event.from_user
    if user is None:
        return False
    if not rate_ok(user.id):
        return False
    return True


@router.message(CommandStart())
async def cmd_start(message: Message) -> None:
    if not await _guard(message):
        return
    await message.answer(WELCOME, reply_markup=keyboard())


@router.message(Command("help"))
async def cmd_help(message: Message) -> None:
    if not await _guard(message):
        return
    await message.answer(HELP, reply_markup=keyboard())


@router.message(Command("link"))
async def cmd_link(message: Message) -> None:
    if not await _guard(message):
        return
    alive, _, keys = source_stats()
    if not keys:
        await message.answer(NO_LINK)
        return
    await message.answer(
        f"<b>Ссылка для Happ</b>\n<code>{sub_link()}</code>\n\n"
        f"Живых серверов: {keys}. Нажмите на ссылку, чтобы скопировать.",
    )


@router.message(Command("status"))
async def cmd_status(message: Message) -> None:
    if not await _guard(message):
        return
    alive, dead, keys = source_stats()
    db = SessionLocal()
    try:
        mode = get_mode(db)
    finally:
        db.close()
    await message.answer(
        f"<b>Состояние</b>\n"
        f"Источников живых: {alive}, мёртвых: {dead}\n"
        f"Ключей в подписке: {keys}\n"
        f"Режим: {'белые списки' if mode == MODE_WHITELIST else 'обычный'}",
        reply_markup=keyboard(),
    )


@router.message(Command("refresh"))
async def cmd_refresh(message: Message) -> None:
    if not await _guard(message):
        return
    start_refresh("bot")
    await message.answer("Обновляю. Это займёт до минуты — пришлю итог.")


@router.message(Command("addkey"))
async def cmd_addkey(message: Message, state: FSMContext) -> None:
    if not await _guard(message):
        return
    if not is_admin(message.from_user.id):
        return
    await state.set_state(AddKey.waiting)
    await message.answer(
        "Пришлите ключ или ссылку подписки одним сообщением.\n"
        "Можно несколько строк сразу."
    )


@router.message(AddKey.waiting)
async def handle_keys(message: Message, state: FSMContext) -> None:
    if not message.text:
        await message.answer("Нужен текст: ключ <code>vless://…</code> или ссылка.")
        return
    if not is_admin(message.from_user.id):
        await state.clear()
        return

    await message.answer("Проверяю, подождите…")
    results = await asyncio.to_thread(_add_keys_sync, message.text)
    await state.clear()

    alive = sum(item.get("alive", 0) for item in results)
    lines = [f"<b>Добавлено</b>: строк {len(results)}, живых ключей {alive}"]
    for item in results[:8]:
        if item.get("error"):
            lines.append(f"• {item['name']}: {item['error'][:60]}")
    await message.answer("\n".join(lines))


def _add_keys_sync(text: str) -> list[dict]:
    db = SessionLocal()
    try:
        return add_lines(db, text)
    finally:
        db.close()


@router.callback_query(F.data == "act:link")
async def cb_link(callback: CallbackQuery) -> None:
    await callback.answer()
    _, _, keys = source_stats()
    if not keys:
        await callback.message.answer(NO_LINK)
        return
    await callback.message.answer(
        f"<b>Ссылка для Happ</b>\n<code>{sub_link()}</code>",
    )


@router.callback_query(F.data == "act:devices")
async def cb_devices(callback: CallbackQuery) -> None:
    await callback.answer()
    await callback.message.answer("Выберите устройство:", reply_markup=keyboard(device_menu()))


@router.callback_query(F.data.startswith("dev:"))
async def cb_device(callback: CallbackQuery) -> None:
    device = callback.data.split(":", 1)[1]
    db = SessionLocal()
    try:
        text = instruction(db, device)
    finally:
        db.close()

    await callback.answer()
    await callback.message.answer(
        f"<b>{DEVICE_TITLES.get(device, device)}</b>\n{text}",
        reply_markup=keyboard([[("Открыть в Happ", "act:open")], [("Назад", "act:devices")]]),
    )


@router.callback_query(F.data == "act:open")
async def cb_open(callback: CallbackQuery) -> None:
    await callback.answer()
    _, _, keys = source_stats()
    if not keys:
        await callback.message.answer(NO_LINK)
        return
    # happ:// понимают не все клиенты — ссылку даём рядом текстом.
    await callback.message.answer(
        f"Откройте в Happ: <code>{sub_link()}</code>\n"
        "Если кнопка ниже не сработает, скопируйте ссылку и вставьте вручную."
    )
    await callback.message.answer(f'happ://add/{sub_link()}')


@router.callback_query(F.data == "act:cabinet")
async def cb_cabinet(callback: CallbackQuery) -> None:
    await callback.answer()
    from .people_handlers import send_cabinet

    await send_cabinet(callback.message, str(callback.from_user.id))


@router.callback_query(F.data == "act:status")
async def cb_status(callback: CallbackQuery) -> None:
    await callback.answer()
    alive, dead, keys = source_stats()
    db = SessionLocal()
    try:
        mode = get_mode(db)
    finally:
        db.close()
    await callback.message.answer(
        f"Источников: живых {alive}, мёртвых {dead}. Ключей: {keys}.\n"
        f"Режим: {'белые списки' if mode == MODE_WHITELIST else 'обычный'}.",
    )


@router.callback_query(F.data == "act:refresh")
async def cb_refresh(callback: CallbackQuery) -> None:
    if not is_admin(callback.from_user.id):
        await callback.answer(NO_ACCESS, show_alert=True)
        return
    await callback.answer("Запустил")
    start_refresh("bot")
    await callback.message.answer("Обновляю. Итог пришлю сюда же.")


@router.callback_query(F.data == "act:back")
async def cb_back(callback: CallbackQuery) -> None:
    await callback.answer()
    await callback.message.answer(WELCOME, reply_markup=keyboard())


@router.callback_query(F.data == "act:plans")
async def cb_plans(callback: CallbackQuery) -> None:
    await callback.answer()
    await callback.message.answer(
        "Тарифы и оплата — у администратора.\n"
        "Пробный доступ выдаётся один раз."
    )


@router.callback_query(F.data == "act:help")
async def cb_help(callback: CallbackQuery) -> None:
    await callback.answer()
    await callback.message.answer(HELP, reply_markup=keyboard())


@router.message(Command("mode"))
async def cmd_mode(message: Message) -> None:
    if not is_admin(message.from_user.id):
        return
    parts = (message.text or "").split(maxsplit=1)
    db = SessionLocal()
    try:
        if len(parts) == 1:
            current = get_mode(db)
            await message.answer(
                f"Режим сейчас: {'белые списки' if current == MODE_WHITELIST else 'обычный'}.\n"
                "Переключить: /mode whitelist или /mode normal"
            )
            return
        wanted = parts[1].strip().lower()
        if wanted not in ("normal", "whitelist"):
            await message.answer("Нужно: /mode normal или /mode whitelist")
            return
        set_mode(db, wanted)
        db.commit()
    finally:
        db.close()
    await message.answer("Режим переключён. Ссылка в Happ обновится сама.")


@router.message(Command("probe"))
async def cmd_probe(message: Message) -> None:
    if not is_admin(message.from_user.id):
        return
    result = await probe_once()
    await message.answer(
        f"Российский сайт: {'открыт' if result['ru_ok'] else 'закрыт'}\n"
        f"Зарубежный сайт: {'открыт' if result['foreign_ok'] else 'закрыт'}\n"
        f"Режим: {'белые списки' if result['mode'] == MODE_WHITELIST else 'обычный'}"
    )


@router.message(Command("report"))
async def cmd_report(message: Message) -> None:
    if not is_admin(message.from_user.id):
        return
    db = SessionLocal()
    try:
        sources = db.execute(select(Source).order_by(Source.id)).scalars().all()
    finally:
        db.close()

    if not sources:
        await message.answer("Источников пока нет. Добавьте: /addkey")
        return

    lines = ["<b>Источники</b>"]
    for source in sources[:15]:
        tail = ""
        if source.days_left is not None:
            tail = f", {source.days_left} дн."
        lines.append(f"• {source.name}: {source.status}{tail}")
    await message.answer("\n".join(lines))


# Команды для людей (/users, /grant, /broadcast, /stats) — в people_handlers.py
