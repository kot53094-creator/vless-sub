"""Экраны сайта: главная с мастером, действия, живой лог."""

from __future__ import annotations

import asyncio
import json
import secrets

from fastapi import APIRouter, Depends, Form, Request
from fastapi.responses import HTMLResponse, JSONResponse, RedirectResponse, StreamingResponse
from sqlalchemy import select
from sqlalchemy.orm import Session

from .. import security
from ..config import settings
from ..db import get_db
from ..models import Event, Probe, Setting, Source
from ..services import notifier
from ..services.builder import MODE_NORMAL, MODE_WHITELIST, build, get_mode, set_mode
from ..services.bus import bus
from ..services.detector import last_probe, probe_once
from ..services.sources import add_lines
from ..services.sync import start_refresh
from ..ui import templates

router = APIRouter()


def _ensure_token(db: Session) -> str:
    row = db.get(Setting, "sub_token")
    if row and row.value:
        return row.value
    token = settings.sub_token or secrets.token_urlsafe(24)
    db.merge(Setting(key="sub_token", value=token))
    db.commit()
    return token


@router.get("/login", response_class=HTMLResponse)
def login_page(request: Request):
    return templates.TemplateResponse(
        "login.html", {"request": request, "error": "", "totp": security.totp_enabled()}
    )


@router.post("/login")
def login_submit(
    request: Request,
    username: str = Form(""),
    password: str = Form(""),
    totp: str = Form(""),
    db: Session = Depends(get_db),
):
    ip = request.client.host if request.client else "?"
    if security.too_many_attempts(ip):
        return templates.TemplateResponse(
            "login.html",
            {"request": request, "error": "Слишком много попыток. Подождите 10 минут.", "totp": security.totp_enabled()},
            status_code=429,
        )
    if username.strip() != settings.admin_user or not security.verify_password(password):
        security.register_attempt(ip)
        return templates.TemplateResponse(
            "login.html",
            {"request": request, "error": "Неверный логин или пароль", "totp": security.totp_enabled()},
            status_code=401,
        )
    if not security.verify_totp(totp):
        security.register_attempt(ip)
        return templates.TemplateResponse(
            "login.html",
            {"request": request, "error": "Неверный код из приложения", "totp": True},
            status_code=401,
        )

    request.session["user"] = settings.admin_user
    _ensure_token(db)
    return RedirectResponse("/", status_code=303)


@router.get("/logout")
def logout(request: Request):
    request.session.clear()
    return RedirectResponse("/login", status_code=303)


@router.get("/", response_class=HTMLResponse)
def index(request: Request, db: Session = Depends(get_db)):
    if not security.current_user(request):
        return RedirectResponse("/login", status_code=303)

    token = _ensure_token(db)
    sources = db.execute(select(Source).order_by(Source.id.desc())).scalars().all()
    mode = get_mode(db)
    probe = last_probe(db)

    # Ближайшая рекомендация — одна, без списка.
    hint = ""
    expiring = sorted(
        [s for s in sources if s.days_left is not None and s.days_left <= 3],
        key=lambda s: s.days_left or 0,
    )
    if not sources:
        hint = "Начните с первого шага: вставьте ссылку или ключ."
    elif expiring:
        src = expiring[0]
        hint = f"«{src.name}»: {src.days_left} дн. Добавьте новый источник заранее."
    elif all(s.status == "dead" for s in sources):
        hint = "Все источники мертвы. Нажмите «Обновить всё» или добавьте новый."
    elif mode == MODE_WHITELIST:
        hint = "Включён режим «белые списки»: первыми идут мосты и CDN."

    _, keys = build(db, mode)
    return templates.TemplateResponse("index.html", {
        "request": request,
        "sources": sources,
        "mode": mode,
        "probe": probe,
        "hint": hint,
        "sub_url": f"{settings.app_url}/sub/{token}",
        "keys_count": keys,
        "csrf": security.csrf_token(request),
        "people_enabled": settings.people_enabled,
        "warnings": settings.warnings(),
        "events": db.execute(select(Event).order_by(Event.ts.desc()).limit(6)).scalars().all(),
    })


@router.post("/api/sources/add")
def api_add(request: Request, payload: dict, db: Session = Depends(get_db)):
    security.require_user(request)
    security.check_csrf(request, str(payload.get("csrf", "")))
    raw = str(payload.get("text", ""))
    if not raw.strip():
        return JSONResponse({"error": "Вставьте ссылку или ключ"}, status_code=400)
    results = add_lines(db, raw)
    return JSONResponse({"results": results})


@router.post("/api/sources/preview")
def api_preview(request: Request, payload: dict, db: Session = Depends(get_db)):
    """Разобрать строки и показать, что найдётся — без сохранения."""
    security.require_user(request)
    security.check_csrf(request, str(payload.get("csrf", "")))
    raw = str(payload.get("text", ""))
    normalized = raw.replace(chr(13), chr(10))
    lines = [line.strip() for line in normalized.split(chr(10)) if line.strip()][:40]
    if not lines:
        return JSONResponse({"error": "Вставьте ссылку или ключ"}, status_code=400)

    from ..services.parser import is_subscription_url, parse_subscription, parse_uri
    from ..services.sources import fetch_subscription, guess_kind

    items = []
    for line in lines:
        item = {"line": line[:120], "kind": guess_kind(line), "found": 0, "hosts": [], "error": ""}
        if is_subscription_url(line):
            try:
                body, _info = fetch_subscription(line, "preview")
                keys = parse_subscription(body)
                item["found"] = len(keys)
                item["hosts"] = [f"{k.host}:{k.port}" for k in keys[:5]]
                if not keys:
                    item["error"] = "в подписке нет ключей"
            except Exception as exc:  # noqa: BLE001
                item["error"] = f"не скачалась: {type(exc).__name__}"
        else:
            parsed = parse_uri(line)
            if parsed:
                item["found"] = 1
                item["hosts"] = [f"{parsed.host}:{parsed.port}"]
            else:
                item["error"] = "не похоже на ключ"
        items.append(item)
    return JSONResponse({"items": items})


@router.post("/api/sources/{source_id}/delete")
def api_delete(source_id: int, request: Request, payload: dict, db: Session = Depends(get_db)):
    security.require_user(request)
    security.check_csrf(request, str(payload.get("csrf", "")))
    source = db.get(Source, source_id)
    if not source:
        return JSONResponse({"error": "Источник не найден"}, status_code=404)
    name = source.name
    db.delete(source)
    db.commit()
    return JSONResponse({"ok": True, "name": name})


@router.post("/api/mode")
def api_mode(request: Request, payload: dict, db: Session = Depends(get_db)):
    security.require_user(request)
    security.check_csrf(request, str(payload.get("csrf", "")))
    mode = str(payload.get("mode", ""))
    if mode not in (MODE_NORMAL, MODE_WHITELIST):
        return JSONResponse({"error": "Неизвестный режим"}, status_code=400)
    set_mode(db, mode)
    db.commit()
    return JSONResponse({"ok": True, "mode": mode})


@router.post("/api/refresh")
def api_refresh(request: Request, payload: dict | None = None, db: Session = Depends(get_db)):
    security.require_user(request)
    if payload:
        security.check_csrf(request, str(payload.get("csrf", "")))
    run_id = start_refresh("manual")
    return JSONResponse({"run_id": run_id})


@router.get("/api/refresh/{run_id}/events")
async def refresh_events(run_id: str, request: Request):
    security.require_user(request)
    queue = bus.subscribe(run_id)

    async def stream():
        try:
            while True:
                try:
                    line = await asyncio.wait_for(queue.get(), timeout=20)
                except asyncio.TimeoutError:
                    yield ": keep-alive\n\n"
                    continue
                if line.startswith("__done__ "):
                    payload = {"type": "done", "summary": line[len("__done__ "):]}
                    yield f"data: {json.dumps(payload, ensure_ascii=False)}\n\n"
                    break
                yield f"data: {json.dumps({'type': 'log', 'text': line}, ensure_ascii=False)}\n\n"
        finally:
            bus.unsubscribe(run_id, queue)

    return StreamingResponse(stream(), media_type="text/event-stream", headers={
        "Cache-Control": "no-cache",
        "X-Accel-Buffering": "no",
    })


@router.post("/api/detector/check")
async def api_detector(request: Request, payload: dict | None = None):
    security.require_user(request)
    if payload:
        security.check_csrf(request, str(payload.get("csrf", "")))
    result = await probe_once()
    return JSONResponse(result)


@router.get("/api/status")
def api_status(request: Request, db: Session = Depends(get_db)):
    security.require_user(request)
    probe = db.execute(select(Probe).order_by(Probe.ts.desc()).limit(1)).scalar_one_or_none()
    return JSONResponse({
        "mode": get_mode(db),
        "sources": db.execute(select(Source)).scalars().all().__len__(),
        "probe": None if not probe else {"ru_ok": probe.ru_ok, "foreign_ok": probe.foreign_ok,
                                          "mode": probe.mode, "ts": probe.ts.isoformat()},
    })


@router.get("/people", response_class=HTMLResponse)
def people(request: Request):
    if not security.current_user(request):
        return RedirectResponse("/login", status_code=303)
    if not settings.people_enabled:
        # Модуль B выключен — не отдаём пустой экран, а объясняем, что делать.
        return templates.TemplateResponse("people_off.html", {"request": request,
                                                              "warnings": settings.warnings()})
    return templates.TemplateResponse("people.html", {"request": request})
