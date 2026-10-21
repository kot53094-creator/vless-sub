"""hub-sync: скачать источники, проверить узлы, пересобрать подписку."""

from __future__ import annotations

import asyncio
import sys
from collections.abc import Awaitable, Callable
from datetime import datetime, timezone

from sqlalchemy import delete, select
from sqlalchemy.orm import Session

from ..config import settings
from ..db import SessionLocal
from ..models import Event, Node, Source, SyncRun
from . import checker, devices, fetcher, health, notifier, parser, subscription, traffic

LogFn = Callable[[str], Awaitable[None]] | Callable[[str], None]


def _print_safe(message: str) -> None:
    """Windows-консоль бывает в cp1251 — не роняем синхронизацию из-за символов."""
    try:
        print(message, flush=True)
    except UnicodeEncodeError:
        enc = sys.stdout.encoding or "utf-8"
        print(message.encode(enc, "replace").decode(enc, "replace"), flush=True)


async def _log(cb: LogFn | None, message: str) -> None:
    _print_safe(message)
    if cb is None:
        return
    result = cb(message)
    if asyncio.iscoroutine(result):
        await result


def _now() -> datetime:
    return datetime.now(timezone.utc)


async def run_sync(log_cb: LogFn | None = None, mode: str = subscription.MODE_NORMAL) -> dict:
    """Полный проход. Возвращает сводку."""
    started = _now()
    db: Session = SessionLocal()
    run = SyncRun(started_at=started)
    db.add(run)
    db.commit()
    db.refresh(run)

    report: list[str] = []

    def note(message: str) -> None:
        report.append(message)

    sources = db.execute(
        select(Source).where(Source.status != "disabled").order_by(Source.priority)
    ).scalars().all()

    await _log(log_cb, f"Старт: источников {len(sources)}")
    run.sources_total = len(sources)

    checked: list[dict] = []
    dead_sources = 0

    for src in sources:
        was_active = src.status == "active"
        await _log(log_cb, f"{src.name} [{src.kind}]")

        if parser.is_single_key(src.url):
            text = src.url
        else:
            result = await fetcher.fetch_source(src.url)
            if not result.ok:
                src.status = "dead"
                src.last_error = (result.error or "пустой ответ")[:300]
                src.last_checked_at = _now()
                db.add(Event(level="warn", message=f"{src.name}: {src.last_error}"[:400]))
                await _log(log_cb, f"  ошибка: {src.last_error}")
                dead_sources += 1
                db.commit()
                continue
            text = result.text
            info = parser.parse_userinfo(result.header("subscription-userinfo"))
            if info.get("download"):
                src.used_bytes = int(info["download"])
            if info.get("total"):
                src.total_bytes = int(info["total"])
            if info.get("expire"):
                src.expire_at_panel = datetime.fromtimestamp(int(info["expire"]), tz=timezone.utc)

        nodes, raw_count = parser.parse_subscription(text)
        await _log(log_cb, f"  ссылок {raw_count}, уникальных {len(nodes)}")

        if not nodes:
            src.status = "dead"
            src.last_error = "нет узлов"
            src.last_checked_at = _now()
            db.add(Event(level="warn", message=f"{src.name}: нет поддерживаемых узлов"[:400]))
            dead_sources += 1
            db.commit()
            continue

        results = await checker.check_many(nodes)
        alive = [item for item in results if item.get("alive")]
        checked.extend(alive)

        db.execute(delete(Node).where(Node.source_id == src.id))
        now = _now()
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
        await _log(log_cb, f"  живых {len(alive)} из {len(results)}")

        best = min((r for r in alive if r.get("latency_ms")), key=lambda r: r["latency_ms"], default=None)
        health.record(db, src.id, bool(alive),
                      best["latency_ms"] if best else None,
                      "" if alive else "все узлы мертвы")

        if alive:
            if best:
                note(f"{src.name}: {len(alive)} узлов, минимум {best['latency_ms']} мс")
        elif was_active:
            db.add(Event(level="error", message=f"Нода «{src.name}» упала: все узлы мертвы"[:400]))
            if notifier.enabled():
                await notifier.send(notifier.format_node_down(
                    src.name, f"проверено {len(results)} узлов, ни один не ответил"))

        db.commit()

    # Снимок трафика: из него считаются суточный и месячный расход.
    try:
        traffic.record(db)
        traffic.prune(db)
    except Exception as exc:  # noqa: BLE001 - метрики не должны ломать сборку
        await _log(log_cb, f"Трафик: {type(exc).__name__}")

    encoded, published = subscription.build(db, mode)
    run.finished_at = _now()
    run.nodes_alive = len(checked)
    run.nodes_dead = dead_sources
    run.published = published
    run.ok = published > 0
    run.log = "\n".join(report)[:20000]
    db.add(Event(
        level="info" if published else "error",
        message=f"hub-sync: {published} узлов из {len(sources)} источников"[:400],
    ))
    db.commit()

    summary = {
        "published": published,
        "alive": len(checked),
        "dead_sources": dead_sources,
        "seconds": round((run.finished_at - started).total_seconds(), 1),
        "size": len(encoded),
    }
    await _log(log_cb, f"Готово: опубликовано {published} узлов за {summary['seconds']} с")

    # Remnawave: новые устройства по HWID и упавшие ноды.
    if settings.remnawave_url and settings.remnawave_token:
        try:
            from .remnawave import Remnawave

            panel = Remnawave()
            panel_users = await panel.users()
            for user in panel_users[:30]:
                try:
                    items = await panel.devices(user.uuid)
                except Exception:  # noqa: BLE001 - один ключ не должен ломать обход
                    items = []
                if items:
                    await devices.watch(db, user.username, items, notify=notifier.enabled())
                else:
                    await devices.watch_counts(db, {user.username: user.devices},
                                               notify=notifier.enabled())

            offline = [n.name or n.address for n in await panel.nodes() if not n.connected]
            if offline:
                db.add(Event(level="error",
                             message=f"Remnawave: ноды не на связи — {', '.join(offline[:5])}"[:400]))
                if notifier.enabled():
                    await notifier.send(notifier.format_remnawave_nodes(offline[:10]))
            await _log(log_cb, f"Remnawave: пользователей {len(panel_users)}, нод без связи {len(offline)}")
        except Exception as exc:  # noqa: BLE001 - панель не должна ломать sync
            await _log(log_cb, f"Remnawave недоступна: {type(exc).__name__}")

    # Сроки ключей, аренды и исчерпанный трафик.
    try:
        from . import deadlines

        sent = await deadlines.scan(notify=notifier.enabled())
        if sent:
            await _log(log_cb, f"Предупреждений о сроках: {len(sent)}")
    except Exception as exc:  # noqa: BLE001
        await _log(log_cb, f"Дедлайны: {type(exc).__name__}")

    # Итог одной строкой и предупреждения — в Telegram, если он настроен.
    if notifier.enabled():
        await notifier.send(notifier.format_sync(summary))
        warnings: list[tuple[str, int | None, int | None]] = []
        for src in db.execute(select(Source).where(Source.status == "active")).scalars():
            total = src.total_bytes or src.traffic_limit
            pct = int(src.used_bytes / total * 100) if total else None
            days = src.days_left
            if (days is not None and days <= 3) or (pct is not None and pct >= 80):
                warnings.append((src.name, days, pct))
        if warnings:
            await notifier.send(notifier.format_expiring(warnings[:15]))

    db.close()
    return summary
