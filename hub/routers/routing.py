"""Экран «Маршрутизация»: правила и экспорт профиля для Happ."""

from __future__ import annotations

from fastapi import APIRouter, Depends, Form, HTTPException, Request
from fastapi.responses import HTMLResponse, JSONResponse, RedirectResponse
from sqlalchemy.orm import Session

from .. import security
from ..config import settings
from ..db import get_db
from ..models import Event, RouteRule
from ..services import routing, subscription
from ..services.parser import mask_secret
from ..templating import templates

router = APIRouter()


def _mode(db: Session) -> str:
    from ..models import Setting

    row = db.get(Setting, "mode")
    return row.value if row else subscription.MODE_NORMAL


@router.get("/routing", response_class=HTMLResponse)
def routing_page(request: Request, db: Session = Depends(get_db)):
    if not security.current_user(request):
        return RedirectResponse("/login", status_code=303)

    rules = routing.ordered_rules(db)
    route = routing.build_route(db, _mode(db))
    full_url = f"{settings.public_base_url}/sub/{settings.sub_token}/routing"
    return templates.TemplateResponse("routing.html", {
        "request": request,
        "rules": rules,
        "route": route,
        "counters": routing.summary(route),
        "labels": routing.OUTBOUND_LABELS,
        "match_types": [
            ("domain", "домен (и поддомены)"),
            ("geosite", "категория geosite"),
            ("geoip", "страна geoip"),
            ("ip", "IP/CIDR"),
            ("network", "протокол (tcp/udp)"),
        ],
        "preview": routing.profile_json(db, _mode(db)),
        "routing_url": full_url,
        "routing_url_masked": f"{settings.public_base_url}/sub/{mask_secret(settings.sub_token)}/routing",
        "mode": _mode(db),
    })


@router.post("/api/routing")
def add_rule(
    request: Request,
    name: str = Form(""),
    match_type: str = Form("domain"),
    value: str = Form(""),
    outbound: str = Form("main"),
    note: str = Form(""),
    sort: str = Form("100"),
    csrf: str = Form(""),
    db: Session = Depends(get_db),
):
    security.require_user(request)
    security.check_csrf(request, csrf)

    values = routing.split_values(value)
    if not values:
        raise HTTPException(400, "Укажите домен, категорию или подсеть")

    rule = RouteRule(
        name=name.strip()[:120] or values[0][:120],
        match_type=routing.normalize_match_type(match_type),
        value=", ".join(values)[:400],
        outbound=routing.normalize_outbound(outbound),
        note=note.strip()[:300],
        sort=int(sort) if sort.strip().lstrip("-").isdigit() else 100,
    )
    db.add(rule)
    db.add(Event(level="info", message=f"Маршрут: «{rule.name}» → {rule.outbound}"[:400]))
    db.commit()
    return RedirectResponse("/routing", status_code=303)


@router.post("/api/routing/{rule_id}/toggle")
def toggle_rule(rule_id: int, request: Request, csrf: str = Form(""),
                db: Session = Depends(get_db)):
    security.require_user(request)
    security.check_csrf(request, csrf)
    rule = db.get(RouteRule, rule_id)
    if rule:
        rule.enabled = not rule.enabled
        db.commit()
    return RedirectResponse("/routing", status_code=303)


@router.post("/api/routing/{rule_id}/delete")
def delete_rule(rule_id: int, request: Request, csrf: str = Form(""),
                db: Session = Depends(get_db)):
    security.require_user(request)
    security.check_csrf(request, csrf)
    rule = db.get(RouteRule, rule_id)
    if rule:
        db.delete(rule)
        db.add(Event(level="info", message=f"Маршрут удалён: «{rule.name}»"[:400]))
        db.commit()
    return RedirectResponse("/routing", status_code=303)


@router.get("/api/routing/preview")
def preview(request: Request, db: Session = Depends(get_db)):
    """Тот же JSON, что отдаётся по ссылке — для проверки из браузера."""
    security.require_user(request)
    return JSONResponse(routing.build_profile(db, _mode(db)))
