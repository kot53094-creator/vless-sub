"""Действия: добавить ключ, удалить источник, переключить режим, запустить sync."""

from __future__ import annotations

import asyncio
import json
from datetime import datetime, timedelta, timezone

from fastapi import APIRouter, Depends, Form, HTTPException, Request
from fastapi.responses import HTMLResponse, RedirectResponse, StreamingResponse
from sqlalchemy import delete, select
from sqlalchemy.orm import Session

from .. import security
from ..db import get_db
from ..models import Event, Node, Server, Setting, Source, utcnow
from ..services import checker, detector, fetcher, health, parser, subscription, sync

router = APIRouter()


def _guard(request: Request, token: str | None) -> str:
    user = security.require_user(request)
    security.check_csrf(request, token)
    return user


@router.post("/api/sources")
async def add_source(
    request: Request,
    name: str = Form(""),
    kind: str = Form("trial"),
    url: str = Form(""),
    note: str = Form(""),
    trial_days: str = Form(""),
    traffic_gb: str = Form(""),
    csrf: str = Form(""),
    db: Session = Depends(get_db),
):
    try:
        _guard(request, csrf)
    except HTTPException as exc:
        return RedirectResponse("/login", status_code=303) if exc.status_code == 303 else HTMLResponse("CSRF", status_code=400)

    raw = url.strip()
    if not raw:
        return templates_error(request, "Вставьте ссылку подписки или vless://")

    if kind not in {"own_vps", "trial", "public", "bridge_ru", "cdn_xhttp"}:
        kind = "trial"

    # Проверяем ключ до сохранения, чтобы не тащить мусор в подписку.
    if parser.is_single_key(raw):
        nodes, _ = parser.parse_subscription(raw)
        if not nodes:
            return templates_error(request, "Ссылка не разобралась: проверьте формат ключа")
        sample = nodes[0]
        result = await checker.check_node(sample)
        if not result.get("alive"):
            return templates_error(request, f"Ключ не отвечает ({sample['host']}:{sample['port']})")
    else:
        fetched = await fetcher.fetch_source(raw)
        if not fetched.ok:
            return templates_error(request, f"Подписка не скачалась: {fetched.error}")
        if not parser.parse_subscription(fetched.text)[0]:
            return templates_error(request, "В подписке нет поддерживаемых узлов")

    days = int(trial_days) if trial_days.strip().isdigit() else None
    limit = int(float(traffic_gb) * 1024 ** 3) if traffic_gb.strip() else None

    src = Source(
        name=name.strip() or f"Ключ {utcnow():%d.%m %H:%M}",
        kind=kind,
        url=raw,
        note=note.strip()[:300],
        trial_days=days,
        traffic_limit=limit,
        expires_at=(utcnow() + timedelta(days=days)) if days else None,
        priority=10 if kind == "own_vps" else 50 if kind == "trial" else 90,
    )
    db.add(src)
    db.add(Event(level="info", message=f"Добавлен источник «{src.name}» [{kind}]"))
    db.commit()
    return RedirectResponse("/sources", status_code=303)


def templates_error(request: Request, message: str) -> HTMLResponse:
    from ..templating import templates

    return templates.TemplateResponse("add_key.html", {
        "request": request, "error": message, "ok": "",
    }, status_code=400)


@router.post("/api/sources/{source_id}/delete")
def delete_source(source_id: int, request: Request, csrf: str = Form(""),
                  db: Session = Depends(get_db)):
    _guard(request, csrf)
    src = db.get(Source, source_id)
    if src:
        db.delete(src)
        db.add(Event(level="info", message=f"Удалён источник «{src.name}»"))
        db.commit()
    return RedirectResponse("/sources", status_code=303)


@router.post("/api/sources/{source_id}/toggle")
def toggle_source(source_id: int, request: Request, csrf: str = Form(""),
                  db: Session = Depends(get_db)):
    _guard(request, csrf)
    src = db.get(Source, source_id)
    if src:
        src.status = "active" if src.status == "disabled" else "disabled"
        db.commit()
    return RedirectResponse("/sources", status_code=303)


@router.post("/api/mode")
def set_mode(request: Request, mode: str = Form("normal"), csrf: str = Form(""),
             db: Session = Depends(get_db)):
    _guard(request, csrf)
    if mode not in {subscription.MODE_NORMAL, subscription.MODE_WHITELIST}:
        raise HTTPException(400, "unknown mode")
    row = db.get(Setting, "mode") or Setting(key="mode")
    row.value = mode
    db.merge(row)
    label = "белые списки" if mode == subscription.MODE_WHITELIST else "обычный"
    db.add(Event(level="warn", message=f"Режим сети переключён: {label}"))
    db.commit()
    return RedirectResponse(request.headers.get("referer", "/"), status_code=303)


@router.post("/api/sync")
async def run_sync_now(request: Request, csrf: str = Form(""), db: Session = Depends(get_db)):
    _guard(request, csrf)
    mode = _current_mode(db)
    summary = await sync.run_sync(mode=mode)
    return RedirectResponse("/sync?done=1", status_code=303)


@router.get("/api/sync/stream")
async def sync_stream(request: Request):
    """SSE-лог: строки приходят по мере обработки источников."""
    security.require_user(request)
    db = SessionLocal()
    mode = _current_mode(db)
    db.close()

    queue: asyncio.Queue[str] = asyncio.Queue()

    async def push(line: str) -> None:
        await queue.put(line)

    async def runner() -> None:
        try:
            await sync.run_sync(log_cb=push, mode=mode)
        except Exception as exc:  # noqa: BLE001
            await queue.put(f"Ошибка: {exc}")
        finally:
            await queue.put("__done__")

    task = asyncio.create_task(runner())

    async def stream():
        try:
            while True:
                try:
                    line = await asyncio.wait_for(queue.get(), timeout=20)
                except asyncio.TimeoutError:
                    yield ": keep-alive\n\n"
                    continue
                if line == "__done__":
                    yield "event: done\ndata: ok\n\n"
                    break
                yield f"data: {json.dumps(line, ensure_ascii=False)}\n\n"
        finally:
            if not task.done():
                task.cancel()

    return StreamingResponse(stream(), media_type="text/event-stream",
                             headers={"Cache-Control": "no-cache", "X-Accel-Buffering": "no"})


def _current_mode(db: Session) -> str:
    row = db.get(Setting, "mode")
    return row.value if row else subscription.MODE_NORMAL


@router.post("/api/detector/check")
async def detector_check(request: Request, csrf: str = Form(""),
                         db: Session = Depends(get_db)):
    """Одна ручная проверка: доступен ли российский сайт и зарубежный."""
    _guard(request, csrf)
    result = await detector.check_once()
    db.add(Event(level="info",
                 message=f"Проверка сети: RU={'да' if result['ru_ok'] else 'нет'}, "
                         f"зарубеж={'да' if result['foreign_ok'] else 'нет'}"))
    db.commit()
    return RedirectResponse("/settings?checked=1", status_code=303)


@router.post("/api/sources/{source_id}/check")
async def check_source(source_id: int, request: Request, csrf: str = Form(""),
                       db: Session = Depends(get_db)):
    """Проверить один источник сейчас: скачать, распарсить, проверить узлы."""
    _guard(request, csrf)
    src = db.get(Source, source_id)
    if not src:
        return RedirectResponse("/sources", status_code=303)

    if parser.is_single_key(src.url):
        text = src.url
    else:
        fetched = await fetcher.fetch_source(src.url)
        if not fetched.ok:
            src.status = "dead"
            src.last_error = (fetched.error or "нет ответа")[:300]
            src.last_checked_at = utcnow()
            health.record(db, src.id, False, None, src.last_error)
            db.add(Event(level="warn", message=f"Проверка «{src.name}»: {src.last_error}"[:400]))
            db.commit()
            return RedirectResponse("/sources", status_code=303)
        text = fetched.text
        info = parser.parse_userinfo(fetched.header("subscription-userinfo"))
        if info.get("download"):
            src.used_bytes = int(info["download"])
        if info.get("total"):
            src.total_bytes = int(info["total"])
        if info.get("expire"):
            src.expire_at_panel = datetime.fromtimestamp(int(info["expire"]), tz=timezone.utc)

    nodes, _ = parser.parse_subscription(text)
    results = await checker.check_many(nodes) if nodes else []
    alive = [item for item in results if item.get("alive")]
    best = min((r["latency_ms"] for r in alive if r.get("latency_ms")), default=None)

    db.execute(delete(Node).where(Node.source_id == src.id))
    now = utcnow()
    for item in results:
        db.add(Node(
            source_id=src.id,
            uri=item["uri"],
            fingerprint=item["fingerprint"],
            proto=item.get("proto", "vless"),
            host=item.get("host", ""),
            port=int(item.get("port", 443) or 443),
            remark=(item.get("remark") or "")[:200],
            alive=bool(item.get("alive")),
            tcp_ok=bool(item.get("tcp_ok")),
            tls_ok=bool(item.get("tls_ok")),
            latency_ms=item.get("latency_ms"),
            checked_at=now,
        ))

    src.status = "active" if alive else "dead"
    src.last_checked_at = now
    src.last_error = "" if alive else "все узлы мертвы"
    src.last_report = f"{len(alive)}/{len(results)} живых"
    health.record(db, src.id, bool(alive), best,
                  "" if alive else "все узлы мертвы")
    db.add(Event(level="info" if alive else "warn",
                 message=f"Проверка «{src.name}»: {len(alive)} из {len(results)} живых"[:400]))
    db.commit()
    return RedirectResponse("/sources", status_code=303)


@router.post("/api/telegram/check")
async def telegram_check(request: Request, csrf: str = Form(""), db: Session = Depends(get_db)):
    """Проверить бота: getMe, найти chat_id из последних сообщений, отправить тест."""
    _guard(request, csrf)
    from ..services import notifier

    me = await notifier.api_call("getMe")
    if not me or not me.get("ok"):
        db.add(Event(level="error", message="Telegram: бот не отвечает — проверьте токен и доступ к api.telegram.org"))
        db.commit()
        return RedirectResponse("/settings?tg=fail", status_code=303)

    chat = ""
    updates = await notifier.api_call("getUpdates", limit=20) or {}
    for item in reversed(updates.get("result") or []):
        message = item.get("message") or item.get("channel_post") or {}
        cid = (message.get("chat") or {}).get("id")
        if cid:
            chat = str(cid)
            break

    if chat:
        row = db.get(Setting, "telegram_chat_id") or Setting(key="telegram_chat_id")
        row.value = chat
        db.merge(row)
        db.commit()

    sent = False
    if chat:
        sent = await notifier.send("<b>VPN Hub</b>: связь с ботом установлена.")

    db.add(Event(level="info", message=(
        f"Telegram: @{me['result'].get('username', '?')}, "
        f"chat={chat or 'не найден'}, тест={'отправлен' if sent else 'не отправлен'}")[:400]))
    db.commit()
    return RedirectResponse(f"/settings?tg={'ok' if sent else 'nochat'}", status_code=303)
