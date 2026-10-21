"""Экран «Серверы»: аренда, остаток дней и автоустановка ноды по SSH."""

from __future__ import annotations

import asyncio
import math
from datetime import datetime, timedelta, timezone

from fastapi import APIRouter, Depends, Form, Request
from fastapi.responses import HTMLResponse, RedirectResponse
from sqlalchemy import select
from sqlalchemy.orm import Session

from .. import security
from ..crypto import encrypt
from ..db import SessionLocal, get_db
from ..models import Event, Server, Source, utcnow
from ..services import provision as prov
from ..templating import templates

router = APIRouter()

_running: set[int] = set()


def _now() -> datetime:
    return datetime.now(timezone.utc)


def _days_left(server: Server) -> int | None:
    if not server.rent_until:
        return None
    until = server.rent_until
    if until.tzinfo is None:
        until = until.replace(tzinfo=timezone.utc)
    return math.ceil((until - _now()).total_seconds() / 86400)


@router.get("/servers", response_class=HTMLResponse)
def servers_page(request: Request, db: Session = Depends(get_db)):
    if not security.current_user(request):
        return RedirectResponse("/login", status_code=303)
    servers = db.execute(select(Server).order_by(Server.id)).scalars().all()
    return templates.TemplateResponse("servers.html", {
        "request": request,
        "servers": servers,
        "days": {s.id: _days_left(s) for s in servers},
        "running": _running,
    })


@router.post("/api/servers")
def add_server(
    request: Request,
    name: str = Form(""),
    ip: str = Form(""),
    ssh_user: str = Form("root"),
    ssh_port: str = Form("22"),
    secret: str = Form(""),
    provider: str = Form(""),
    country: str = Form(""),
    role: str = Form("direct"),
    price: str = Form(""),
    rent_days: str = Form(""),
    panel_url: str = Form(""),
    csrf: str = Form(""),
    db: Session = Depends(get_db),
):
    security.require_user(request)
    security.check_csrf(request, csrf)

    if not ip.strip():
        return RedirectResponse("/servers?error=ip", status_code=303)

    server = Server(
        name=name.strip() or ip.strip(),
        ip=ip.strip(),
        ssh_user=ssh_user.strip() or "root",
        ssh_port=int(ssh_port) if ssh_port.strip().isdigit() else 22,
        ssh_secret_enc=encrypt(secret.strip()),
        provider=provider.strip(),
        country=country.strip(),
        role=role if role in {"direct", "bridge", "cdn"} else "direct",
        price=float(price) if price.strip().replace(".", "", 1).isdigit() else 0.0,
        rent_until=(utcnow() + timedelta(days=int(rent_days))) if rent_days.strip().isdigit() else None,
        panel_url=panel_url.strip()[:400],
        status="new",
    )
    db.add(server)
    db.add(Event(level="info", message=f"Добавлен сервер «{server.name}» ({server.ip})"))
    db.commit()
    db.refresh(server)
    return RedirectResponse(f"/servers?added={server.id}", status_code=303)


@router.post("/api/servers/{server_id}/delete")
def delete_server(server_id: int, request: Request, csrf: str = Form(""),
                  db: Session = Depends(get_db)):
    security.require_user(request)
    security.check_csrf(request, csrf)
    server = db.get(Server, server_id)
    if server:
        db.delete(server)
        db.add(Event(level="warn", message=f"Удалён сервер «{server.name}»"))
        db.commit()
    return RedirectResponse("/servers", status_code=303)


async def _install(server_id: int, node_name: str, node_port: int, hy2_port: int,
                   replace_server_id: int | None = None) -> None:
    """Фоновая установка: обновляет статус и лог сервера.

    `replace_server_id` — перенос с другого сервера: после успеха старый
    источник отключается, чтобы выдача не тянула мёртвую ноду.
    """
    _running.add(server_id)
    db = SessionLocal()
    try:
        server = db.get(Server, server_id)
        if not server:
            return
        server.status = "provisioning"
        server.log = "подключаюсь по SSH…"
        db.commit()

        target = prov.target_from_server(server)
        try:
            result = await prov.provision(target, node_name=node_name,
                                          node_port=node_port, hy2_port=hy2_port)
            server.links = "\n".join(result.links)
            server.log = result.log[-8000:]
            server.status = "active"
            server.provisioned_at = utcnow()
            if result.ip:
                server.ip = result.ip

            src = Source(
                name=f"{server.name} (нода)",
                kind="own_vps",
                url=result.links[0],
                note="создан автоматически при установке ноды",
                priority=5,
            )
            db.add(src)
            db.flush()
            server.source_id = src.id
            db.add(Event(level="info", message=f"Нода «{server.name}» установлена: {len(result.links)} ссылки"))

            if replace_server_id:
                old = db.get(Server, replace_server_id)
                if old:
                    if old.source_id:
                        old_src = db.get(Source, old.source_id)
                        if old_src:
                            old_src.status = "disabled"
                    old.status = "replaced"
                    db.add(Event(level="info",
                                 message=f"Нода «{server.name}» заменила «{old.name}»"[:400]))
        except prov.ProvisionError as exc:
            server.status = "error"
            server.log = str(exc)[:8000]
            db.add(Event(level="error", message=f"Установка «{server.name}»: {exc}"[:400]))
        db.commit()
    except Exception as exc:  # noqa: BLE001
        db.rollback()
        db.add(Event(level="error", message=f"Установка ноды: {type(exc).__name__}: {exc}"[:400]))
        db.commit()
    finally:
        db.close()
        _running.discard(server_id)


@router.post("/api/servers/{server_id}/install")
async def install(server_id: int, request: Request, csrf: str = Form(""),
                  node_port: str = Form("443"), hy2_port: str = Form("8443"),
                  db: Session = Depends(get_db)):
    security.require_user(request)
    security.check_csrf(request, csrf)
    server = db.get(Server, server_id)
    if not server or server_id in _running:
        return RedirectResponse("/servers", status_code=303)
    asyncio.create_task(_install(
        server_id,
        node_name=server.name,
        node_port=int(node_port) if node_port.isdigit() else 443,
        hy2_port=int(hy2_port) if hy2_port.isdigit() else 8443,
    ))
    return RedirectResponse("/servers", status_code=303)


@router.get("/servers/{server_id}/migrate", response_class=HTMLResponse)
def migrate_page(server_id: int, request: Request, db: Session = Depends(get_db)):
    """Форма «Создать на новом сервере»: перенос ноды на другую машину."""
    if not security.current_user(request):
        return RedirectResponse("/login", status_code=303)
    old = db.get(Server, server_id)
    if not old:
        return RedirectResponse("/servers", status_code=303)
    return templates.TemplateResponse("migrate.html", {
        "request": request,
        "old": old,
        "days": _days_left(old),
        "error": request.query_params.get("error", ""),
    })


@router.post("/api/servers/{server_id}/migrate")
async def migrate(
    server_id: int,
    request: Request,
    ip: str = Form(""),
    ssh_user: str = Form("root"),
    ssh_port: str = Form("22"),
    secret: str = Form(""),
    name: str = Form(""),
    rent_days: str = Form(""),
    node_port: str = Form("443"),
    hy2_port: str = Form("8443"),
    csrf: str = Form(""),
    db: Session = Depends(get_db),
):
    security.require_user(request)
    security.check_csrf(request, csrf)

    old = db.get(Server, server_id)
    if not old:
        return RedirectResponse("/servers", status_code=303)
    if not ip.strip():
        return RedirectResponse(f"/servers/{server_id}/migrate?error=ip", status_code=303)

    fresh = Server(
        name=name.strip() or f"{old.name}-new",
        ip=ip.strip(),
        ssh_user=ssh_user.strip() or "root",
        ssh_port=int(ssh_port) if ssh_port.strip().isdigit() else 22,
        ssh_secret_enc=encrypt(secret.strip()),
        provider=old.provider,
        country=old.country,
        role=old.role,
        price=old.price,
        panel_url=old.panel_url,
        rent_until=(utcnow() + timedelta(days=int(rent_days))) if rent_days.strip().isdigit() else None,
        status="new",
    )
    db.add(fresh)
    db.commit()
    db.refresh(fresh)

    asyncio.create_task(_install(
        fresh.id,
        node_name=fresh.name,
        node_port=int(node_port) if node_port.isdigit() else 443,
        hy2_port=int(hy2_port) if hy2_port.isdigit() else 8443,
        replace_server_id=old.id,
    ))
    db.add(Event(level="info", message=f"Перенос ноды «{old.name}» → «{fresh.name}» начат"[:400]))
    db.commit()
    return RedirectResponse("/servers?migrating=1", status_code=303)


@router.post("/api/servers/{server_id}/load")
async def refresh_load(server_id: int, request: Request, csrf: str = Form(""),
                       db: Session = Depends(get_db)):
    """Прочитать нагрузку сервера по SSH (loadavg + память)."""
    security.require_user(request)
    security.check_csrf(request, csrf)
    server = db.get(Server, server_id)
    if not server:
        return RedirectResponse("/servers", status_code=303)

    try:
        target = prov.target_from_server(server)
        pct, info = await prov.read_load(target)
        server.load_pct = pct
        if info:
            server.os_info = info[:120]
        db.add(Event(level="info", message=f"Нагрузка «{server.name}»: {pct}% ({info})"[:400]))
    except prov.ProvisionError as exc:
        db.add(Event(level="error", message=f"Нагрузка «{server.name}»: {exc}"[:400]))
    db.commit()
    return RedirectResponse("/servers", status_code=303)
