"""Служебные команды: пароль, TOTP, сводка, ручная синхронизация."""

from __future__ import annotations

import argparse
import asyncio
import sys

from sqlalchemy import select

from .config import settings
from .db import SessionLocal, init_db
from .models import Source
from .security import hash_password


def _hash(args) -> int:
    print(hash_password(args.password))
    return 0


def _totp(_args) -> int:
    import pyotp

    secret = pyotp.random_base32()
    print(f"TOTP_SECRET={secret}")
    print("otpauth://" + pyotp.TOTP(secret).provisioning_uri(name=settings.admin_user,
                                                            issuer_name="VPN Hub").split("otpauth://", 1)[-1])
    return 0


def _status(_args) -> int:
    init_db()
    db = SessionLocal()
    try:
        sources = db.execute(select(Source)).scalars().all()
        print(f"источников: {len(sources)}")
        for source in sources:
            print(f"  [{source.kind}] {source.name}: {source.status}, ключей {len(source.keys)}")
    finally:
        db.close()
    return 0


def _sync(_args) -> int:
    from .services.sync import run_refresh

    init_db()
    result = run_refresh("cli")
    print(f"живых: {result['alive']}, мёртвых: {result['dead']}, ключей: {result['keys']}")
    return 0


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(prog="python -m app.cli")
    sub = parser.add_subparsers(dest="command", required=True)

    p_hash = sub.add_parser("hash-password", help="хеш пароля для ADMIN_PASSWORD_HASH")
    p_hash.add_argument("password")
    p_hash.set_defaults(func=_hash)

    p_totp = sub.add_parser("totp-secret", help="секрет для второго фактора")
    p_totp.set_defaults(func=_totp)

    p_status = sub.add_parser("status", help="сводка по источникам")
    p_status.set_defaults(func=_status)

    p_sync = sub.add_parser("sync", help="обновить всё из консоли")
    p_sync.set_defaults(func=_sync)
    return parser


def main(argv: list[str] | None = None) -> int:
    args = build_parser().parse_args(argv)
    for warning in settings.warnings():
        print(f"[!] {warning}", file=sys.stderr)
    return int(args.func(args) or 0)


if __name__ == "__main__":  # pragma: no cover
    raise SystemExit(main())
