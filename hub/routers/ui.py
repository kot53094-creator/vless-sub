"""Страницы интерфейса."""

from __future__ import annotations

import asyncio
from datetime import datetime, timedelta, timezone

from fastapi import APIRouter, Depends, Form, Request
from fastapi.responses import HTMLResponse, RedirectResponse, StreamingResponse
from sqlalchemy import desc, func, select
from sqlalchemy.orm import Session

from .. import security
from ..db import SessionLocal, get_db
from ..models import Event, Node, Server, Source, SyncRun, utcnow
from ..services import detector, subscription
from ..services.remnawave import Remnawave
from ..templating import templates

router = APIRouter()


def _mode(db: Session) -> str:
    from ..models import Setting

    row = db.get(Setting, "mode")
    return row.value if row else subscription.MODE_NORMAL


def _detector_state(db: Session) -> dict | None:
    state = detector.load_state(db)
    if not state.get("checked_at"):
        return None
    return state


@router.get("/login", response_class=HTMLResponse)
def login_page(request: Request):
    return templates.TemplateResponse("login.html", {"request": request, "error": ""})


@router.post("/login")
def login_submit(request: Request, username: str = Form(""), password: str = Form("")):
    ip = request.client.host if request.client else "?"
    if security.too_many_attempts(ip):
        return templates.TemplateResponse(
            "login.html", {"request": request, "error": "Слишком много попыток. Подождите 5 минут."},
            status_code=429)
    if username.strip() != security.settings.admin_user or not security.verify_password(password):
        security.register_attempt(ip)
        return templates.TemplateResponse(
            "login.html", {"request": request, "error": "Неверный логин или пароль"}, status_code=401)
    response = RedirectResponse("/", status_code=303)
    security.issue_session(response, username.strip())
    return response


@router.get("/logout")
def logout():
    response = RedirectResponse("/login", status_code=303)
    response.delete_cookie(security.COOKIE_SESSION)
    response.delete_cookie(security.COOKIE_CSRF)
    return response


@router.get("/", response_class=HTMLResponse)
def dashboard(request: Request, db: Session = Depends(get_db)):
    if not security.current_user(request):
        return RedirectResponse("/login", status_code=303)

    sources = db.execute(select(Source)).scalars().all()
    alive_nodes = db.execute(select(func.count()).select_from(Node).where(Node.alive.is_(True))).scalar() or 0
    total_nodes = db.execute(select(func.count()).select_from(Node)).scalar() or 0

    total_used = sum(s.used_bytes or 0 for s in sources)
    limits = [s.total_bytes for s in sources if s.total_bytes]
    total_limit = sum(limits) if limits else None

    expiring = sorted(
        [s for s in sources if s.days_left is not None and s.days_left <= 7 and s.status != "disabled"],
        key=lambda s: s.days_left or 0,
    )
    servers = db.execute(select(Server)).scalars().all()
    events = db.execute(select(Event).order_by(desc(Event.ts)).limit(12)).scalars().all()
    last_run = db.execute(select(SyncRun).order_by(desc(SyncRun.started_at)).limit(1)).scalar_one_or_none()

    return templates.TemplateResponse("dashboard.html", {
        "request": request,
        "mode": _mode(db),
        "sources": sources,
        "alive_nodes": alive_nodes,
        "total_nodes": total_nodes,
        "total_used": total_used,
        "total_limit": total_limit,
        "expiring": expiring,
        "servers": servers,
        "events": events,
        "last_run": last_run,
        "remna_configured": Remnawave().configured,
        "now": utcnow(),
    })


@router.get("/sources", response_class=HTMLResponse)
def sources_page(request: Request, db: Session = Depends(get_db)):
    if not security.current_user(request):
        return RedirectResponse("/login", status_code=303)
    sources = db.execute(select(Source).order_by(Source.priority, Source.id)).scalars().all()
    counts = dict(db.execute(
        select(Node.source_id, func.count()).where(Node.alive.is_(True)).group_by(Node.source_id)
    ).all())
    return templates.TemplateResponse("sources.html", {
        "request": request, "sources": sources, "alive": counts, "mode": _mode(db),
    })


@router.get("/add", response_class=HTMLResponse)
def add_page(request: Request):
    if not security.current_user(request):
        return RedirectResponse("/login", status_code=303)
    return templates.TemplateResponse("add_key.html", {"request": request, "error": "", "ok": ""})


@router.get("/settings", response_class=HTMLResponse)
def settings_page(request: Request, db: Session = Depends(get_db)):
    if not security.current_user(request):
        return RedirectResponse("/login", status_code=303)
    from ..config import settings as cfg

    return templates.TemplateResponse("settings.html", {
        "request": request,
        "mode": _mode(db),
        "sub_url": f"{cfg.public_base_url}/sub/{cfg.sub_token}",
        "warnings": cfg.warnings(),
        "sync_hours": cfg.sync_interval_hours,
        "detector": _detector_state(db),
        "detector_enabled": cfg.detector_enabled,
        "detector_interval": cfg.detector_interval,
        "threshold": 3,
        "telegram": bool(cfg.telegram_token and cfg.telegram_chat),
    })


@router.get("/sync", response_class=HTMLResponse)
def sync_page(request: Request, db: Session = Depends(get_db)):
    if not security.current_user(request):
        return RedirectResponse("/login", status_code=303)
    runs = db.execute(select(SyncRun).order_by(desc(SyncRun.started_at)).limit(10)).scalars().all()
    return templates.TemplateResponse("sync.html", {"request": request, "runs": runs, "mode": _mode(db)})
