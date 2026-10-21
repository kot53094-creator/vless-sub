"""Люди в боте: пробный доступ, кабинет, админ-команды."""

from __future__ import annotations

from aiogram import F, Router
from aiogram.filters import Command
from aiogram.types import CallbackQuery, InlineKeyboardButton, InlineKeyboardMarkup, Message
from sqlalchemy import func, select

from ..config import settings
from ..db import SessionLocal
from ..models import Person
from ..services import people as svc
from ..services.people import PeopleError
from ..services.remnawave import RemnawaveError
from .access import is_admin
from .texts import NO_ACCESS

router = Router()
GB = 1024 ** 3


def kb(rows: list[list[tuple[str, str]]]) -> InlineKeyboardMarkup:
    return InlineKeyboardMarkup(inline_keyboard=[
        [InlineKeyboardButton(text=label, callback_data=data) if not data.startswith("http")
         else InlineKeyboardButton(text=label, url=data) for label, data in row]
        for row in rows
    ])


async def channel_ok(bot, user_id: int) -> bool:
    """Обязательная подписка на канал, если он задан."""
    if not settings.channel_id:
        return True
    try:
        member = await bot.get_chat_member(settings.channel_id, user_id)
        return member.status in ("member", "administrator", "creator")
    except Exception:  # noqa: BLE001 - бот не админ канала или канал неверный
        return True


def ask_channel() -> InlineKeyboardMarkup:
    rows = []
    if settings.channel_id.startswith("@"):
        rows.append([("Открыть канал", f"https://t.me/{settings.channel_id.lstrip('@')}")])
    rows.append([("Проверить", "p:check_channel")])
    return kb(rows)


def cabinet_text(person: Person) -> str:
    traffic = "без лимита"
    if person.traffic_limit:
        used = (person.traffic_used or 0) / GB
        total = person.traffic_limit / GB
        traffic = f"{used:.1f} из {total:.0f} ГБ"
    days = person.days_left
    left = "срок не задан" if days is None else ("истёк" if days < 0 else f"{days} дн.")
    return (
        f"<b>Кабинет</b>\n"
        f"Срок: {left}\n"
        f"Трафик: {traffic}\n"
        f"Устройств: до {person.device_limit}\n\n"
        + (f"<code>{person.sub_url}</code>" if person.sub_url else
           "Ссылка появится, когда панель создаст профиль.")
    )


async def send_cabinet(target: Message, tg_id: str) -> None:
    db = SessionLocal()
    try:
        person = svc.find_person(db, tg_id)
        if not person:
            await target.answer("Доступа ещё нет. Нажмите «Пробный доступ».")
            return
        text = cabinet_text(person)
    finally:
        db.close()

    await target.answer(text, reply_markup=kb([
        [("Перевыпустить ссылку", "p:revoke"), ("Устройства", "p:devices")],
        [("Написать в поддержку", "p:support")],
    ]))


@router.callback_query(F.data == "p:trial")
async def cb_trial(callback: CallbackQuery, bot) -> None:
    if not settings.people_enabled:
        await callback.answer("Раздел «Люди» выключен", show_alert=True)
        return
    if not await channel_ok(bot, callback.from_user.id):
        await callback.answer()
        await callback.message.answer("Сначала подпишитесь на канал.", reply_markup=ask_channel())
        return

    db = SessionLocal()
    try:
        person = await svc.start_trial(db, str(callback.from_user.id),
                                       callback.from_user.username or "")
    except (PeopleError, RemnawaveError) as exc:
        await callback.answer()
        await callback.message.answer(str(exc))
        return
    finally:
        db.close()

    await callback.answer("Готово")
    await callback.message.answer(
        f"<b>Пробный доступ открыт</b>\n"
        f"{settings.trial_days} дн., {settings.trial_gb} ГБ, {settings.trial_devices} устройства.\n\n"
        + (f"<code>{person.sub_url}</code>" if person.sub_url else "Ссылку пришлю чуть позже.")
        + "\n\nВ Happ: «+» → «Импорт по ссылке»."
    )


@router.callback_query(F.data == "p:check_channel")
async def cb_check_channel(callback: CallbackQuery, bot) -> None:
    if await channel_ok(bot, callback.from_user.id):
        await callback.answer("Спасибо!")
        await send_cabinet(callback.message, str(callback.from_user.id))
    else:
        await callback.answer("Пока не видно подписки", show_alert=True)


@router.callback_query(F.data == "p:cabinet")
async def cb_cabinet(callback: CallbackQuery) -> None:
    await callback.answer()
    await send_cabinet(callback.message, str(callback.from_user.id))


@router.callback_query(F.data == "p:revoke")
async def cb_revoke(callback: CallbackQuery) -> None:
    db = SessionLocal()
    try:
        await svc.revoke_link(db, str(callback.from_user.id))
        person = svc.find_person(db, str(callback.from_user.id))
        text = "Ссылка перевыпущена. Старая больше не работает.\n\n" + (
            f"<code>{person.sub_url}</code>" if person and person.sub_url else "")
    except (PeopleError, RemnawaveError) as exc:
        text = str(exc)
    finally:
        db.close()
    await callback.answer()
    await callback.message.answer(text)


@router.callback_query(F.data == "p:devices")
async def cb_devices(callback: CallbackQuery) -> None:
    db = SessionLocal()
    try:
        person = svc.find_person(db, str(callback.from_user.id))
        devices = await svc.devices_for(person.remnawave_uuid) if person else []
    except (PeopleError, RemnawaveError) as exc:
        await callback.answer()
        await callback.message.answer(str(exc))
        return
    finally:
        db.close()

    if not devices:
        await callback.answer()
        await callback.message.answer("Устройств пока нет.")
        return

    rows = [[(f"Удалить {(d.model or d.platform or 'устройство')[:20]}", f"p:dev:{d.hwid[:20]}")]
            for d in devices[:6]]
    await callback.answer()
    await callback.message.answer(
        "Ваши устройства:\n" + "\n".join(f"• {d.model or d.platform or '—'}" for d in devices),
        reply_markup=kb(rows),
    )


@router.callback_query(F.data == "p:support")
async def cb_support(callback: CallbackQuery) -> None:
    await callback.answer()
    await callback.message.answer(
        "Напишите администратору: он ответит здесь же.\n"
        "Если сервер не работает — попробуйте другой из списка."
    )
    try:
        await callback.bot.send_message(
            settings.admin_tg_id,
            f"<b>Обращение</b> от {callback.from_user.id}"
            + (f" @{callback.from_user.username}" if callback.from_user.username else ""),
        )
    except Exception:  # noqa: BLE001
        pass


# ─── Админ ───────────────────────────────────────────────────────────────────

def _need_admin(message: Message) -> bool:
    return is_admin(message.from_user.id if message.from_user else None)


@router.message(Command("users"))
async def cmd_users(message: Message) -> None:
    if not _need_admin(message) or not settings.people_enabled:
        return
    db = SessionLocal()
    try:
        people = db.execute(select(Person).order_by(Person.created_at.desc()).limit(25)).scalars().all()
    finally:
        db.close()
    if not people:
        await message.answer("Людей пока нет.")
        return
    lines = ["<b>Люди</b>"]
    for person in people:
        name = f"@{person.username}" if person.username else person.tg_id
        lines.append(f"• {name} · {person.status} · {person.days_left if person.days_left is not None else '—'} дн.")
    await message.answer("\n".join(lines))


@router.message(Command("user"))
async def cmd_user(message: Message) -> None:
    if not _need_admin(message):
        return
    parts = (message.text or "").split()
    if len(parts) < 2:
        await message.answer("Формат: /user &lt;tg_id&gt;")
        return
    db = SessionLocal()
    try:
        person = svc.find_person(db, parts[1])
        if not person:
            await message.answer("Не нашёл.")
            return
        await message.answer(cabinet_text(person))
    finally:
        db.close()


@router.message(Command("grant"))
async def cmd_grant(message: Message) -> None:
    if not _need_admin(message):
        return
    parts = (message.text or "").split()
    if len(parts) < 3:
        await message.answer("Формат: /grant &lt;tg_id&gt; &lt;дней&gt; [ГБ]")
        return
    days = int(parts[2]) if parts[2].lstrip("-").isdigit() else 30
    gb = int(parts[3]) if len(parts) > 3 and parts[3].isdigit() else None
    db = SessionLocal()
    try:
        await svc.grant(db, parts[1], days, gb)
        await message.answer(f"Выдано {parts[1]}: {days} дн." + (f", {gb} ГБ" if gb else ""))
    except (PeopleError, RemnawaveError) as exc:
        await message.answer(str(exc))
    finally:
        db.close()


@router.message(Command("extend"))
async def cmd_extend(message: Message) -> None:
    if not _need_admin(message):
        return
    parts = (message.text or "").split()
    if len(parts) < 3:
        await message.answer("Формат: /extend &lt;tg_id&gt; &lt;дней&gt;")
        return
    db = SessionLocal()
    try:
        await svc.grant(db, parts[1], int(parts[2]))
        await message.answer("Продлено.")
    except (PeopleError, RemnawaveError, ValueError) as exc:
        await message.answer(str(exc))
    finally:
        db.close()


@router.message(Command("traffic"))
async def cmd_traffic(message: Message) -> None:
    if not _need_admin(message):
        return
    parts = (message.text or "").split()
    if len(parts) < 3:
        await message.answer("Формат: /traffic &lt;tg_id&gt; &lt;ГБ&gt;")
        return
    db = SessionLocal()
    try:
        await svc.set_traffic(db, parts[1], int(parts[2]))
        await message.answer(f"Лимит трафика: {parts[2]} ГБ")
    except (PeopleError, RemnawaveError, ValueError) as exc:
        await message.answer(str(exc))
    finally:
        db.close()


@router.message(Command("ban"))
async def cmd_ban(message: Message) -> None:
    if not _need_admin(message):
        return
    parts = (message.text or "").split()
    if len(parts) < 2:
        await message.answer("Формат: /ban &lt;tg_id&gt;")
        return
    db = SessionLocal()
    try:
        await svc.set_status(db, parts[1], False)
        await message.answer("Забанен.")
    except (PeopleError, RemnawaveError) as exc:
        await message.answer(str(exc))
    finally:
        db.close()


@router.message(Command("unban"))
async def cmd_unban(message: Message) -> None:
    if not _need_admin(message):
        return
    parts = (message.text or "").split()
    if len(parts) < 2:
        await message.answer("Формат: /unban &lt;tg_id&gt;")
        return
    db = SessionLocal()
    try:
        await svc.set_status(db, parts[1], True)
        await message.answer("Разбанен.")
    except (PeopleError, RemnawaveError) as exc:
        await message.answer(str(exc))
    finally:
        db.close()


@router.message(Command("stats"))
async def cmd_stats(message: Message) -> None:
    if not _need_admin(message):
        return
    db = SessionLocal()
    try:
        total = db.execute(select(func.count()).select_from(Person)).scalar() or 0
        active = db.execute(select(func.count()).select_from(Person)
                            .where(Person.status == "active")).scalar() or 0
        trials = db.execute(select(func.count()).select_from(Person)
                            .where(Person.status == "trial")).scalar() or 0
    finally:
        db.close()
    await message.answer(f"<b>Сводка</b>\nЛюдей: {total}\nАктивных: {active}\nТриалов: {trials}")


@router.callback_query(F.data.startswith("p:dev:"))
async def cb_delete_device(callback: CallbackQuery) -> None:
    prefix = callback.data.split(":", 2)[2]
    db = SessionLocal()
    try:
        person = svc.find_person(db, str(callback.from_user.id))
        if not person:
            await callback.answer(NO_ACCESS, show_alert=True)
            return
        devices = await svc.devices_for(person.remnawave_uuid)
        target = next((d for d in devices if d.hwid.startswith(prefix)), None)
        if not target:
            await callback.answer("Не нашёл устройство", show_alert=True)
            return
        await svc.remove_device(person.tg_id, target.hwid)
        await callback.answer("Удалено")
        await callback.message.answer("Устройство удалено.")
    except (PeopleError, RemnawaveError) as exc:
        await callback.answer(str(exc)[:150], show_alert=True)
    finally:
        db.close()
