"""Раздел «Люди»: список, карточка, тарифы, рассылки, журнал, настройки."""

from __future__ import annotations

import threading
import time
from datetime import datetime, timedelta, timezone

import httpx
from fastapi import APIRouter, Depends, Form, Request
from fastapi.responses import HTMLResponse, RedirectResponse
from sqlalchemy import or_, select
from sqlalchemy.orm import Session

from .. import security
from ..config import settings
from ..db import SessionLocal, get_db
from ..models import AuditLog, Broadcast, Person, Setting, Tariff, utcnow
from ..services import people as svc
from ..services.people import PeopleError
from ..services.remnawave import Remnawave, RemnawaveError
from ..ui import templates

router = APIRouter()
GB = 1024 ** 3


def _guard(request: Request) -> None:
    security.require_user(request)


def _flash(path: str, message: str = "", error: str = "") -> RedirectResponse:
    params = []
    if message:
        params.append(f"ok={message}")
    if error:
        params.append(f"err={error}")
    query = "?" + "&".join(params) if params else ""
    return RedirectResponse(f"{path}{query}", status_code=303)


@router.get("/people", response_class=HTMLResponse)
def people_list(
    request: Request,
    q: str = "",
    status: str = "all",
    filter: str = "all",
    db: Session = Depends(get_db),
):
    _guard(request)
    if not settings.people_enabled:
        return templates.TemplateResponse("people_off.html", {"request": request,
                                                              "warnings": settings.warnings()})

    stmt = select(Person)
    if q.strip():
        needle = f"%{q.strip()}%"
        stmt = stmt.where(or_(Person.tg_id.like(needle), Person.username.like(needle),
                              Person.note.like(needle)))
    if status in ("active", "trial", "expired", "banned"):
        stmt = stmt.where(Person.status == status)

    people = db.execute(stmt.order_by(Person.created_at.desc()).limit(300)).scalars().all()
    now = utcnow()

    def keep(person: Person) -> bool:
        if filter == "expiring":
            return person.expires_at is not None and (person.expires_at - now).days <= 7
        if filter == "traffic":
            return bool(person.traffic_limit) and (person.traffic_used or 0) / person.traffic_limit >= 0.8
        if filter == "trial":
            return person.trial_used == 1 and person.status == "trial"
        if filter == "paid":
            return person.trial_used == 1 and person.status != "trial"
        return True

    people = [person for person in people if keep(person)]
    stats = {
        "total": len(people),
        "active": sum(1 for p in people if p.status == "active"),
        "trial": sum(1 for p in people if p.status == "trial"),
        "expiring": sum(1 for p in people if p.expires_at and (p.expires_at - now).days <= 3),
    }

    return templates.TemplateResponse("people.html", {
        "request": request,
        "people": people,
        "q": q,
        "status": status,
        "filter": filter,
        "stats": stats,
        "csrf": security.csrf_token(request),
        "ok": request.query_params.get("ok", ""),
        "err": request.query_params.get("err", ""),
        "gb": GB,
    })


@router.post("/people/bulk")
def people_bulk(
    request: Request,
    ids: list[int] = Form(default=[]),
    action: str = Form("extend"),
    days: str = Form("30"),
    csrf: str = Form(""),
    db: Session = Depends(get_db),
):
    _guard(request)
    security.check_csrf(request, csrf)
    import asyncio

    done = 0
    for person_id in ids:
        person = db.get(Person, person_id)
        if not person:
            continue
        try:
            if action == "ban":
                asyncio.run(svc.set_status(db, person.tg_id, False))
            elif action == "unban":
                asyncio.run(svc.set_status(db, person.tg_id, True))
            elif action == "reset":
                asyncio.run(svc.reset_traffic(db, person.tg_id))
            else:
                asyncio.run(svc.grant(db, person.tg_id, int(days or 30)))
            done += 1
        except (PeopleError, RemnawaveError):
            continue
    return _flash("/people", f"Готово: {done} человек")


@router.get("/people/{person_id}", response_class=HTMLResponse)
async def person_card(person_id: int, request: Request, db: Session = Depends(get_db)):
    _guard(request)
    if not settings.people_enabled:
        return templates.TemplateResponse("people_off.html", {"request": request,
                                                              "warnings": settings.warnings()})
    person = db.get(Person, person_id)
    if not person:
        return _flash("/people", error="Человек не найден")

    devices = []
    panel_error = ""
    try:
        devices = await svc.devices_for(person.remnawave_uuid)
    except (PeopleError, RemnawaveError) as exc:
        panel_error = str(exc)

    events = db.execute(
        select(AuditLog).where(AuditLog.target == person.tg_id).order_by(AuditLog.ts.desc()).limit(30)
    ).scalars().all()
    tariffs = db.execute(select(Tariff).order_by(Tariff.days)).scalars().all()

    return templates.TemplateResponse("person.html", {
        "request": request,
        "person": person,
        "devices": devices,
        "events": events,
        "tariffs": tariffs,
        "panel_error": panel_error,
        "csrf": security.csrf_token(request),
        "ok": request.query_params.get("ok", ""),
        "err": request.query_params.get("err", ""),
        "gb": GB,
    })


@router.post("/people/{person_id}/action")
async def person_action(
    person_id: int,
    request: Request,
    action: str = Form(""),
    value: str = Form(""),
    csrf: str = Form(""),
    db: Session = Depends(get_db),
):
    _guard(request)
    security.check_csrf(request, csrf)
    person = db.get(Person, person_id)
    if not person:
        return _flash("/people", error="Человек не найден")

    back = f"/people/{person_id}"
    try:
        if action == "extend":
            await svc.grant(db, person.tg_id, int(value or 30))
        elif action == "shorten":
            await svc.grant(db, person.tg_id, -abs(int(value or 1)))
        elif action == "date":
            moment = datetime.fromisoformat(value).replace(tzinfo=timezone.utc)
            if person.remnawave_uuid:
                await Remnawave().update_user(
                    person.remnawave_uuid,
                    expireAt=moment.isoformat().replace("+00:00", "Z"),
                )
            svc.audit(db, "set_date", person.tg_id, str(person.expires_at), str(moment))
            person.expires_at = moment
            db.commit()
        elif action == "traffic":
            await svc.set_traffic(db, person.tg_id, int(value or 0))
        elif action == "devices":
            limit = int(value or 1)
            if person.remnawave_uuid:
                await Remnawave().update_user(person.remnawave_uuid, hwidDeviceLimit=limit)
            svc.audit(db, "device_limit", person.tg_id, str(person.device_limit), str(limit))
            person.device_limit = limit
            db.commit()
        elif action == "squad":
            if person.remnawave_uuid:
                await Remnawave().update_user(person.remnawave_uuid, activeInternalSquads=[value])
            svc.audit(db, "squad", person.tg_id, person.squad, value)
            person.squad = value
            db.commit()
        elif action == "disable":
            await svc.set_status(db, person.tg_id, False)
        elif action == "enable":
            await svc.set_status(db, person.tg_id, True)
        elif action == "reset":
            await svc.reset_traffic(db, person.tg_id)
        elif action == "revoke":
            await svc.revoke_link(db, person.tg_id)
        elif action == "note":
            person.note = value[:1000]
            db.commit()
        elif action == "delete_device":
            await svc.remove_device(person.tg_id, value)
        elif action == "notify":
            _send_bot_message(person.tg_id, value or "Сообщение от администратора.")
        elif action == "tariff":
            tariff = db.get(Tariff, int(value or 0))
            if tariff:
                await svc.grant(db, person.tg_id, tariff.days, tariff.gb)
                person.device_limit = tariff.devices
                person.squad = tariff.squad
                db.commit()
        else:
            return _flash(back, error="Неизвестное действие")
    except (PeopleError, RemnawaveError, ValueError) as exc:
        return _flash(back, error=str(exc)[:200])

    return _flash(back, "Сохранено")


@router.post("/people/{person_id}/grant")
async def person_grant(
    person_id: int,
    request: Request,
    days: str = Form("30"),
    gb: str = Form(""),
    devices: str = Form(""),
    csrf: str = Form(""),
    db: Session = Depends(get_db),
):
    """Выдать доступ: сколько дней, сколько ГБ и сколько устройств — вручную."""
    _guard(request)
    security.check_csrf(request, csrf)
    person = db.get(Person, person_id)
    if not person:
        return _flash("/people", error="Человек не найден")
    back = f"/people/{person_id}"
    try:
        await svc.grant(db, person.tg_id, int(days or 30), int(gb) if gb.strip() else None)
        if devices.strip() and person.remnawave_uuid:
            limit = max(1, int(devices))
            await Remnawave().update_user(person.remnawave_uuid, hwidDeviceLimit=limit)
            svc.audit(db, "device_limit", person.tg_id, str(person.device_limit), str(limit))
            person.device_limit = limit
            db.commit()
    except (PeopleError, RemnawaveError, ValueError) as exc:
        return _flash(back, error=str(exc)[:200])
    return _flash(back, f"Выдано: {days} дн." + (f", {gb} ГБ" if gb.strip() else ""))


@router.get("/tariffs", response_class=HTMLResponse)
def tariffs_page(request: Request, db: Session = Depends(get_db)):
    _guard(request)
    return templates.TemplateResponse("tariffs.html", {
        "request": request,
        "tariffs": db.execute(select(Tariff).order_by(Tariff.days)).scalars().all(),
        "csrf": security.csrf_token(request),
        "ok": request.query_params.get("ok", ""),
        "err": request.query_params.get("err", ""),
        "people_enabled": settings.people_enabled,
    })


@router.post("/tariffs/create")
def tariff_create(
    request: Request,
    name: str = Form(""),
    days: str = Form("30"),
    gb: str = Form("100"),
    devices: str = Form("3"),
    squad: str = Form(""),
    csrf: str = Form(""),
    db: Session = Depends(get_db),
):
    _guard(request)
    security.check_csrf(request, csrf)
    db.add(Tariff(name=(name or "Тариф")[:80], days=max(1, int(days or 30)),
                  gb=max(1, int(gb or 100)), devices=max(1, int(devices or 1)),
                  squad=squad[:80]))
    svc.audit(db, "tariff_create", name, "", f"{days} дн., {gb} ГБ")
    db.commit()
    return _flash("/tariffs", "Тариф добавлен")


@router.post("/tariffs/{tariff_id}/delete")
def tariff_delete(tariff_id: int, request: Request, csrf: str = Form(""),
                  db: Session = Depends(get_db)):
    _guard(request)
    security.check_csrf(request, csrf)
    tariff = db.get(Tariff, tariff_id)
    if tariff:
        svc.audit(db, "tariff_delete", tariff.name)
        db.delete(tariff)
        db.commit()
    return _flash("/tariffs", "Удалено")


@router.get("/broadcasts", response_class=HTMLResponse)
def broadcasts_page(request: Request, db: Session = Depends(get_db)):
    _guard(request)
    return templates.TemplateResponse("broadcasts.html", {
        "request": request,
        "items": db.execute(select(Broadcast).order_by(Broadcast.id.desc()).limit(30)).scalars().all(),
        "csrf": security.csrf_token(request),
        "ok": request.query_params.get("ok", ""),
        "err": request.query_params.get("err", ""),
        "bot_enabled": settings.bot_enabled,
    })


@router.post("/broadcasts/send")
async def broadcast_send(request: Request, text: str = Form(""), csrf: str = Form(""),
                         db: Session = Depends(get_db)):
    _guard(request)
    security.check_csrf(request, csrf)
    if not text.strip():
        return _flash("/broadcasts", error="Пустой текст")
    if not settings.bot_enabled:
        return _flash("/broadcasts", error="BOT_TOKEN не задан")

    record = Broadcast(text=text.strip()[:3500], status="sending")
    db.add(record)
    db.commit()

    recipients = db.execute(select(Person).where(Person.status != "banned")).scalars().all()
    threading.Thread(target=_broadcast_worker, args=(record.id, text.strip(),
                                                     [p.tg_id for p in recipients]),
                     daemon=True).start()
    return _flash("/broadcasts", f"Отправляю: {len(recipients)} человек")


def _broadcast_worker(broadcast_id: int, text: str, tg_ids: list[str]) -> None:
    """Ограничение скорости: 20 сообщений в секунду, чтобы не получить лимит Telegram."""
    sent = failed = 0
    with httpx.Client(timeout=15) as client:
        for index, tg_id in enumerate(tg_ids, start=1):
            try:
                response = client.post(
                    f"https://api.telegram.org/bot{settings.bot_token}/sendMessage",
                    json={"chat_id": tg_id, "text": text, "parse_mode": "HTML",
                          "disable_web_page_preview": True},
                )
                if response.status_code == 200:
                    sent += 1
                else:
                    failed += 1
            except httpx.HTTPError:
                failed += 1
            if index % 20 == 0:
                time.sleep(1)

    db = SessionLocal()
    try:
        record = db.get(Broadcast, broadcast_id)
        if record:
            record.sent = sent
            record.failed = failed
            record.status = "done"
            db.commit()
    finally:
        db.close()


def _send_bot_message(tg_id: str, text: str) -> None:
    if not settings.bot_enabled:
        return
    try:
        httpx.post(
            f"https://api.telegram.org/bot{settings.bot_token}/sendMessage",
            json={"chat_id": tg_id, "text": text[:3500], "parse_mode": "HTML"},
            timeout=10,
        )
    except httpx.HTTPError:
        pass


@router.get("/audit", response_class=HTMLResponse)
def audit_page(request: Request, db: Session = Depends(get_db)):
    _guard(request)
    return templates.TemplateResponse("audit.html", {
        "request": request,
        "items": db.execute(select(AuditLog).order_by(AuditLog.ts.desc()).limit(200)).scalars().all(),
    })


@router.get("/settings", response_class=HTMLResponse)
def settings_page(request: Request, db: Session = Depends(get_db)):
    _guard(request)
    rows = {row.key: row.value for row in db.execute(select(Setting)).scalars()}
    return templates.TemplateResponse("settings.html", {
        "request": request,
        "csrf": security.csrf_token(request),
        "values": rows,
        "ok": request.query_params.get("ok", ""),
        "err": request.query_params.get("err", ""),
        "people_enabled": settings.people_enabled,
        "warnings": settings.warnings(),
        "devices": ["android", "ios", "windows", "macos", "linux"],
    })


@router.post("/settings/instruction")
def settings_instruction(
    request: Request,
    device: str = Form(""),
    text: str = Form(""),
    csrf: str = Form(""),
    db: Session = Depends(get_db),
):
    _guard(request)
    security.check_csrf(request, csrf)
    if device not in ("android", "ios", "windows", "macos", "linux"):
        return _flash("/settings", error="Неизвестное устройство")
    row = db.get(Setting, f"instruction.{device}") or Setting(key=f"instruction.{device}")
    row.value = text.strip()[:2000]
    db.merge(row)
    svc.audit(db, "instruction", device, "", row.value[:80])
    db.commit()
    return _flash("/settings", f"Инструкция для {device} сохранена")
