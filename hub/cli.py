"""Командная строка хаба — для cron и systemd-таймера.

Примеры:
    python -m hub.cli sync                 # один прогон hub-sync
    python -m hub.cli sync --mode whitelist
    python -m hub.cli detect               # одна проверка белых списков
    python -m hub.cli status               # что в базе, без сети
    python -m hub.cli routing              # JSON правил маршрутизации
    python -m hub.cli hash-password 'пароль'
"""

from __future__ import annotations

import argparse
import asyncio
import json
import sys

from .config import settings
from .db import SessionLocal, init_db
from .models import Event, Node, RouteRule, Server, Source
from .services import detector, routing, subscription


def _mode(db, requested: str | None) -> str:
    if requested:
        return requested
    from .models import Setting

    row = db.get(Setting, "mode")
    return row.value if row else subscription.MODE_NORMAL


def _cmd_sync(args: argparse.Namespace) -> int:
    from .services import sync

    init_db()
    db = SessionLocal()
    try:
        mode = _mode(db, args.mode)
    finally:
        db.close()

    summary = asyncio.run(sync.run_sync(mode=mode))
    if args.json:
        print(json.dumps(summary, ensure_ascii=False))
    published = int(summary.get("published") or 0)
    if published:
        print(f"hub-sync: опубликовано {published} узлов", flush=True)
        return 0
    print("hub-sync: опубликованных узлов нет", file=sys.stderr, flush=True)
    return 1


def _cmd_detect(args: argparse.Namespace) -> int:
    init_db()
    result = asyncio.run(detector.check_once(notify=not args.no_notify))
    print(
        f"RU={'да' if result['ru_ok'] else 'нет'} "
        f"зарубеж={'да' if result['foreign_ok'] else 'нет'} "
        f"серия={result['fails']} режим={result['mode']}",
        flush=True,
    )
    return 0


def _cmd_status(_: argparse.Namespace) -> int:
    init_db()
    db = SessionLocal()
    try:
        sources = db.query(Source).all()
        nodes = db.query(Node).all()
        servers = db.query(Server).all()
        alive = [n for n in nodes if n.alive]
        rules = db.query(RouteRule).count()
        events = db.query(Event).count()
        print(f"источников: {len(sources)} (активных {sum(1 for s in sources if s.status == 'active')})")
        print(f"узлов: {len(nodes)}, живых: {len(alive)}")
        print(f"серверов: {len(servers)}, правил маршрутизации: {rules}, событий: {events}")
        for src in sorted(sources, key=lambda s: (s.priority, s.id)):
            days = src.days_left
            tail = f", осталось {days} дн." if days is not None else ""
            print(f"  [{src.kind}] {src.name}: {src.status}{tail}")
    finally:
        db.close()
    return 0


def _cmd_routing(args: argparse.Namespace) -> int:
    init_db()
    db = SessionLocal()
    try:
        print(routing.profile_json(db, _mode(db, None), indent=None if args.compact else 2))
    finally:
        db.close()
    return 0


def _cmd_hash_password(args: argparse.Namespace) -> int:
    from .security import hash_password

    print(hash_password(args.password))
    return 0


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(prog="python -m hub.cli", description="VPN Hub: служебные команды")
    sub = parser.add_subparsers(dest="command", required=True)

    p_sync = sub.add_parser("sync", help="один прогон hub-sync (для cron/systemd)")
    p_sync.add_argument("--mode", choices=["normal", "whitelist"], default=None,
                        help="режим сети; по умолчанию — текущий из базы")
    p_sync.add_argument("--json", action="store_true", help="итог одной JSON-строкой")
    p_sync.set_defaults(func=_cmd_sync)

    p_detect = sub.add_parser("detect", help="одна проверка белых списков")
    p_detect.add_argument("--no-notify", action="store_true", help="без Telegram")
    p_detect.set_defaults(func=_cmd_detect)

    p_status = sub.add_parser("status", help="сводка по базе")
    p_status.set_defaults(func=_cmd_status)

    p_routing = sub.add_parser("routing", help="JSON правил маршрутизации")
    p_routing.add_argument("--compact", action="store_true")
    p_routing.set_defaults(func=_cmd_routing)

    p_hash = sub.add_parser("hash-password", help="argon2-хеш для HUB_ADMIN_PASSWORD_HASH")
    p_hash.add_argument("password")
    p_hash.set_defaults(func=_cmd_hash_password)

    return parser


def main(argv: list[str] | None = None) -> int:
    parser = build_parser()
    args = parser.parse_args(argv)
    for warning in settings.warnings():
        print(f"[warn] {warning}", file=sys.stderr, flush=True)
    return int(args.func(args) or 0)


if __name__ == "__main__":  # pragma: no cover
    raise SystemExit(main())
