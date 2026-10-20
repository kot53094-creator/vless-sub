"""Экран «Ключи»: пользователи Remnawave, устройства и действия."""

from __future__ import annotations

from fastapi import APIRouter, Depends, Form, HTTPException, Request
from fastapi.responses import HTMLResponse, RedirectResponse
from sqlalchemy.orm import Session

from .. import security
from ..db import get_db
from ..models import Event
from ..services.remnawave import Remnawave, RemnawaveError
from ..templating import templates

router = APIRouter()


def _client() -> Remnawave:
    return Remnawave()


@router.get("/keys", response_class=HTMLResponse)
async def keys_page(request: Request):
    if not security.current_user(request):
        return RedirectResponse("/login", status_code=303)

    client = _client()
    if not client.configured:
        return templates.TemplateResponse("keys.html", {
            "request": request, "configured": False, "users": [],
            "error": "Remnawave не настроена: добавьте REMNAWAVE_URL и REMNAWAVE_TOKEN в .env",
        })

    error, users = "", []
    try:
        users = await client.users()
    except RemnawaveError as exc:
        error = str(exc)

    return templates.TemplateResponse("keys.html", {
        "request": request, "configured": True, "users": users, "error": error,
    })


@router.get("/keys/{uuid}", response_class=HTMLResponse)
async def key_detail(uuid: str, request: Request):
    if not security.current_user(request):
        return RedirectResponse("/login", status_code=303)

    client = _client()
    error, user, devices = "", None, []
    try:
        users = await client.users()
        user = next((u for u in users if u.uuid == uuid), None)
        if user is None:
            error = "пользователь не найден в панели"
        else:
            devices = await client.devices(uuid)
    except RemnawaveError as exc:
        error = str(exc)

    return templates.TemplateResponse("key_detail.html", {
        "request": request, "user": user, "devices": devices, "error": error, "uuid": uuid,
    })


def _guard(request: Request, csrf: str) -> None:
    security.require_user(request)
    security.check_csrf(request, csrf)


@router.post("/api/keys/{uuid}/reset-traffic")
async def reset_traffic(uuid: str, request: Request, csrf: str = Form(""),
                        db: Session = Depends(get_db)):
    _guard(request, csrf)
    try:
        await _client().reset_traffic(uuid)
        db.add(Event(level="info", message=f"Remnawave: сброшен трафик {uuid[:8]}"))
        db.commit()
    except RemnawaveError as exc:
        db.add(Event(level="error", message=f"Remnawave reset: {exc}"[:400]))
        db.commit()
    return RedirectResponse(f"/keys/{uuid}", status_code=303)


@router.post("/api/keys/{uuid}/revoke")
async def revoke(uuid: str, request: Request, csrf: str = Form(""),
                 db: Session = Depends(get_db)):
    _guard(request, csrf)
    try:
        await _client().revoke_subscription(uuid)
        db.add(Event(level="warn", message=f"Remnawave: перевыпущена ссылка {uuid[:8]}"))
        db.commit()
    except RemnawaveError as exc:
        db.add(Event(level="error", message=f"Remnawave revoke: {exc}"[:400]))
        db.commit()
    return RedirectResponse(f"/keys/{uuid}", status_code=303)


@router.post("/api/keys/{uuid}/disable")
async def disable(uuid: str, request: Request, csrf: str = Form(""), status: str = Form("DISABLED"),
                  db: Session = Depends(get_db)):
    _guard(request, csrf)
    try:
        await _client().set_status(uuid, status)
        db.add(Event(level="warn", message=f"Remnawave: статус {status} для {uuid[:8]}"))
        db.commit()
    except RemnawaveError as exc:
        db.add(Event(level="error", message=f"Remnawave status: {exc}"[:400]))
        db.commit()
    return RedirectResponse(f"/keys/{uuid}", status_code=303)


@router.post("/api/keys/{uuid}/devices/{hwid}/delete")
async def delete_device(uuid: str, hwid: str, request: Request, csrf: str = Form(""),
                        db: Session = Depends(get_db)):
    _guard(request, csrf)
    try:
        await _client().delete_device(hwid)
        db.add(Event(level="warn", message=f"Remnawave: удалено устройство {hwid[:8]}"))
        db.commit()
    except RemnawaveError as exc:
        db.add(Event(level="error", message=f"Remnawave device: {exc}"[:400]))
        db.commit()
    return RedirectResponse(f"/keys/{uuid}", status_code=303)
