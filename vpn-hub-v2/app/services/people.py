"""Люди: пробный доступ, продление, лимиты, устройства. Через Remnawave."""

from __future__ import annotations

from datetime import timedelta

from sqlalchemy import select
from sqlalchemy.orm import Session

from ..config import settings
from ..models import AuditLog, Person, utcnow
from .remnawave import Remnawave, RemnawaveError

GB = 1024 ** 3


class PeopleError(RuntimeError):
    """Понятная причина для бота и сайта."""


def username_for(tg_id: str) -> str:
    return f"tg_{tg_id}"


def audit(db: Session, action: str, target: str = "", before: str = "",
          after: str = "", actor: str = "admin") -> None:
    db.add(AuditLog(actor=actor, action=action, target=str(target)[:80],
                    before=str(before)[:500], after=str(after)[:500]))


def find_person(db: Session, tg_id: str) -> Person | None:
    return db.execute(select(Person).where(Person.tg_id == str(tg_id))).scalar_one_or_none()


def ensure_enabled() -> Remnawave:
    if not settings.people_enabled:
        raise PeopleError("Панель Remnawave не подключена: раздел «Люди» выключен.")
    return Remnawave()


async def sync_people(db: Session, client: Remnawave | None = None) -> dict:
    """Подтянуть людей из панели в базу: срок, трафик, устройства."""
    client = client or ensure_enabled()
    users = await client.users()
    updated = 0
    for user in users:
        if not user.username.startswith("tg_"):
            continue
        tg_id = user.username[3:]
        person = find_person(db, tg_id)
        if not person:
            person = Person(tg_id=tg_id, username="", status="active", trial_used=0)
            db.add(person)
        person.remnawave_uuid = user.uuid
        if user.sub_url:
            person.sub_url = user.sub_url
        person.expires_at = user.expire_at
        person.traffic_limit = user.limit_bytes
        person.traffic_used = user.used_bytes
        if user.hwid_limit:
            person.device_limit = user.hwid_limit
        if person.status != "banned":
            if user.status.upper() not in ("ACTIVE",):
                person.status = "expired"
            elif person.expires_at and person.expires_at < utcnow():
                person.status = "expired"
            else:
                person.status = "active"
        updated += 1
    db.commit()
    return {"updated": updated, "total": len(users)}


async def start_trial(db: Session, tg_id: str, username: str = "",
                      client: Remnawave | None = None) -> Person:
    """Один пробный доступ на Telegram ID. Повторно — отказ."""
    person = find_person(db, tg_id)
    if person and person.trial_used:
        raise PeopleError("Пробный доступ уже был. Напишите администратору, чтобы продлить.")
    if person and person.status == "banned":
        raise PeopleError("Доступ закрыт. Напишите администратору.")

    client = client or ensure_enabled()
    expire = utcnow() + timedelta(days=settings.trial_days)

    try:
        created = await client.create_user(
            username=username_for(tg_id),
            expire_at=expire,
            traffic_gb=settings.trial_gb,
            device_limit=settings.trial_devices,
            squad=settings.trial_squad,
        )
    except RemnawaveError as exc:
        raise PeopleError(f"Панель не создала пользователя: {exc}") from exc

    if person is None:
        person = Person(tg_id=str(tg_id))
        db.add(person)

    person.username = username[:64]
    person.status = "trial"
    person.trial_used = 1
    person.expires_at = expire
    person.traffic_limit = settings.trial_gb * GB
    person.traffic_used = 0
    person.device_limit = settings.trial_devices
    person.squad = settings.trial_squad
    person.remnawave_uuid = str(created.get("uuid", "")) if isinstance(created, dict) else ""
    audit(db, "trial_start", tg_id, "", f"{settings.trial_days} дн., {settings.trial_gb} ГБ")
    db.commit()
    db.refresh(person)
    return person


async def grant(db: Session, tg_id: str, days: int, gb: int | None = None,
                client: Remnawave | None = None) -> Person:
    """Выдать или продлить доступ."""
    person = find_person(db, tg_id)
    if not person:
        raise PeopleError("Такого человека нет. Он должен сначала написать боту /start.")
    if not person.remnawave_uuid:
        raise PeopleError("Нет связи с панелью: у человека не создан профиль.")

    client = client or ensure_enabled()
    base = person.expires_at if person.expires_at and person.expires_at > utcnow() else utcnow()
    expire = base + timedelta(days=days)
    fields: dict = {"expireAt": expire.isoformat().replace("+00:00", "Z")}
    if gb is not None:
        fields["trafficLimitBytes"] = gb * GB
    fields["status"] = "ACTIVE"

    try:
        await client.update_user(person.remnawave_uuid, **fields)
    except RemnawaveError as exc:
        raise PeopleError(f"Панель не приняла изменения: {exc}") from exc

    before = f"{person.days_left} дн., {person.traffic_limit or 0} Б"
    person.expires_at = expire
    if gb is not None:
        person.traffic_limit = gb * GB
    person.status = "active"
    audit(db, "extend" if days > 0 else "shorten", tg_id, before, f"+{days} дн.")
    db.commit()
    return person


async def set_traffic(db: Session, tg_id: str, gb: int,
                      client: Remnawave | None = None) -> Person:
    person = find_person(db, tg_id)
    if not person or not person.remnawave_uuid:
        raise PeopleError("Человек не найден в панели.")
    client = client or ensure_enabled()
    before = person.traffic_limit
    await client.update_user(person.remnawave_uuid, trafficLimitBytes=max(0, gb) * GB)
    person.traffic_limit = max(0, gb) * GB
    audit(db, "traffic", tg_id, str(before or 0), str(person.traffic_limit))
    db.commit()
    return person


async def set_status(db: Session, tg_id: str, active: bool,
                     client: Remnawave | None = None) -> Person:
    person = find_person(db, tg_id)
    if not person:
        raise PeopleError("Человек не найден.")
    client = client or ensure_enabled()
    if person.remnawave_uuid:
        await client.update_user(person.remnawave_uuid, status="ACTIVE" if active else "DISABLED")
    before = person.status
    person.status = "active" if active else "banned"
    audit(db, "unban" if active else "ban", tg_id, before, person.status)
    db.commit()
    return person


async def reset_traffic(db: Session, tg_id: str, client: Remnawave | None = None) -> Person:
    person = find_person(db, tg_id)
    if not person or not person.remnawave_uuid:
        raise PeopleError("Человек не найден в панели.")
    client = client or ensure_enabled()
    await client.reset_traffic(person.remnawave_uuid)
    person.traffic_used = 0
    audit(db, "reset_traffic", tg_id)
    db.commit()
    return person


async def revoke_link(db: Session, tg_id: str, client: Remnawave | None = None) -> Person:
    person = find_person(db, tg_id)
    if not person or not person.remnawave_uuid:
        raise PeopleError("Человек не найден в панели.")
    client = client or ensure_enabled()
    await client.revoke(person.remnawave_uuid)
    audit(db, "revoke", tg_id)
    db.commit()
    return person


async def remove_device(tg_id: str, hwid: str, client: Remnawave | None = None) -> None:
    client = client or ensure_enabled()
    await client.delete_device(hwid)


async def devices_for(remnawave_uuid: str, client: Remnawave | None = None):
    if not remnawave_uuid:
        return []
    client = client or ensure_enabled()
    return await client.devices(remnawave_uuid)
