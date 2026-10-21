"""Добавление источников: разбор строк, проверка только новых ключей."""

from __future__ import annotations

import hashlib
from concurrent.futures import ThreadPoolExecutor
from datetime import datetime, timezone

import httpx
from sqlalchemy import select
from sqlalchemy.orm import Session

from ..config import settings
from ..models import KIND_LABELS, NodeKey, Source, utcnow
from .checker import check_key
from .parser import (
    ParsedKey,
    is_single_key,
    is_subscription_url,
    parse_subscription,
    parse_uri,
    parse_userinfo,
)

MAX_LINES = 40


def _hwid(source_id: int) -> str:
    """Один фиксированный HWID на источник — чтобы не плодить «устройства»."""
    return hashlib.sha256(f"vpnhub:{settings.secret_key}:{source_id}".encode()).hexdigest()[:24]


def fetch_subscription(url: str, hwid: str) -> tuple[str, dict[str, int | None]]:
    with httpx.Client(timeout=20, follow_redirects=True) as client:
        response = client.get(url, headers={
            "User-Agent": settings.fetch_ua,
            "x-hwid": hwid,
            "Accept": "*/*",
        })
        response.raise_for_status()
        return response.text[:400_000], parse_userinfo(response.headers.get("subscription-userinfo"))


def guess_kind(line: str) -> str:
    """Тип по виду строки: ссылка — публичная подписка, ключ — триал."""
    return "public" if is_subscription_url(line) else "trial"


def auto_name(line: str) -> str:
    if is_subscription_url(line):
        host = line.split("//", 1)[-1].split("/", 1)[0]
        return f"Подписка {host}"[:120]
    parsed = parse_uri(line)
    return f"{parsed.proto.upper()} {parsed.host}"[:120] if parsed else "Ключ"


def check_keys(keys: list[ParsedKey]) -> list:
    if not keys:
        return []
    workers = max(1, min(settings.check_workers, len(keys)))
    with ThreadPoolExecutor(max_workers=workers) as pool:
        return list(pool.map(lambda k: check_key(k, settings.check_timeout), keys))


def add_source(db: Session, line: str) -> dict:
    """Создаёт источник и сразу проверяет его. Возвращает отчёт по строке."""
    line = line.strip()
    report: dict = {"line": line[:120], "kind": guess_kind(line), "ok": False, "found": 0,
                    "alive": 0, "error": "", "name": auto_name(line)}

    source = Source(
        name=auto_name(line),
        kind=report["kind"],
        url=line,
        status="unknown",
        added_at=utcnow(),
        visibility="shareable",
    )
    db.add(source)
    db.commit()
    source.hwid = _hwid(source.id)

    if is_subscription_url(line):
        try:
            body, info = fetch_subscription(line, source.hwid)
        except httpx.HTTPError as exc:
            source.status = "dead"
            source.last_error = f"подписка не скачалась: {exc}"[:300]
            source.last_check_at = utcnow()
            db.commit()
            report["error"] = source.last_error
            return report

        keys = parse_subscription(body)
        report["found"] = len(keys)
        if not keys:
            source.status = "dead"
            source.last_error = "в подписке нет ключей"
            source.last_check_at = utcnow()
            db.commit()
            report["error"] = source.last_error
            return report

        results = check_keys(keys)
        for key, result in zip(keys, results):
            db.add(NodeKey(
                source_id=source.id, uri=key.uri, proto=key.proto, host=key.host, port=key.port,
                remark=key.remark[:200], security=key.security, fingerprint=key.fingerprint,
                alive=result.alive, latency_ms=result.latency_ms, last_error=result.error[:200],
                last_check_at=utcnow(),
            ))
        alive = sum(1 for r in results if r.alive)
        report["alive"] = alive
        source.status = "alive" if alive else "dead"
        source.last_check_at = utcnow()
        source.last_fetch_at = utcnow()
        if info.get("total"):
            source.traffic_total = info["total"]
        if info.get("download"):
            source.traffic_used = info["download"]
        if info.get("expire"):
            source.expires_at = datetime.fromtimestamp(info["expire"], tz=timezone.utc)
        best = min((r.latency_ms for r in results if r.latency_ms), default=None)
        source.latency_ms = best
        db.commit()
        report["ok"] = alive > 0
        return report

    if not is_single_key(line):
        db.delete(source)
        db.commit()
        report["error"] = "не похоже на ключ или ссылку"
        return report

    parsed = parse_uri(line)
    if not parsed:
        db.delete(source)
        db.commit()
        report["error"] = "ключ не разобрался"
        return report

    result = check_key(parsed, settings.check_timeout)
    db.add(NodeKey(
        source_id=source.id, uri=parsed.uri, proto=parsed.proto, host=parsed.host, port=parsed.port,
        remark=parsed.remark[:200], security=parsed.security, fingerprint=parsed.fingerprint,
        alive=result.alive, latency_ms=result.latency_ms, last_error=result.error[:200],
        last_check_at=utcnow(),
    ))
    source.status = "alive" if result.alive else "dead"
    source.latency_ms = result.latency_ms
    source.last_check_at = utcnow()
    source.last_error = result.error[:300]
    db.commit()

    report.update({
        "found": 1,
        "alive": 1 if result.alive else 0,
        "ok": bool(result.alive),
        "error": result.error,
        "host": parsed.host,
        "port": parsed.port,
        "latency": result.latency_ms,
        "proto": parsed.proto,
    })
    return report


def add_lines(db: Session, raw: str) -> list[dict]:
    lines = [line.strip() for line in raw.replace("\r", "").split("\n") if line.strip()]
    if len(lines) > MAX_LINES:
        lines = lines[:MAX_LINES]
    return [add_source(db, line) for line in lines]


def kind_label(kind: str) -> str:
    return KIND_LABELS.get(kind, kind)
