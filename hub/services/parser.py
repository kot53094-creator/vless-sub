"""Разбор подписок.

Основную работу делает уже отлаженный `scripts/merge.py`: он знает VLESS
(включая Reality, XHTTP, mlkem-шифрование), VMess, Trojan и Shadowsocks.
Здесь добавлены Hysteria2 (его merge не умеет) и общая обёртка.
"""

from __future__ import annotations

import base64
import hashlib
import re
import sys
from pathlib import Path
from urllib.parse import parse_qs, unquote, urlsplit

ROOT = Path(__file__).resolve().parents[2]
if str(ROOT / "scripts") not in sys.path:
    sys.path.insert(0, str(ROOT / "scripts"))

import merge  # noqa: E402  (нужен путь выше)

SUPPORTED = {"vless", "vmess", "trojan", "ss", "hysteria2"}


def decode_payload(text: str) -> list[str]:
    """Текст подписки → список ссылок. Понимает base64 и plain."""
    return merge.decode_payload(text)


def _hysteria2(uri: str) -> dict:
    parts = urlsplit(uri)
    params = {k: v[0] for k, v in parse_qs(parts.query).items()}
    host = parts.hostname or ""
    port = parts.port or 443
    remark = unquote(parts.fragment) if parts.fragment else f"{host}:{port}"
    return {
        "proto": "hysteria2",
        "host": host,
        "port": int(port),
        "auth": unquote(parts.username or ""),
        "sni": params.get("sni", ""),
        "remark": remark,
        "uri": uri,
        "fingerprint": _fp("hysteria2", host, str(port), params.get("sni", "")),
        "network": "udp",
        "security": "tls",
    }


def _fp(*parts: str) -> str:
    return hashlib.sha1("|".join(parts).encode()).hexdigest()[:16]


def _remark_of(uri: str) -> str:
    return unquote(uri.split("#", 1)[1]) if "#" in uri else uri[:80]


def parse_uri(uri: str) -> dict | None:
    """Одна ссылка → словарь с полями proto/host/port/remark/fingerprint."""
    uri = uri.strip()
    if not uri or "://" not in uri:
        return None
    scheme = uri.split("://", 1)[0].lower()
    if scheme not in SUPPORTED:
        return None
    if scheme == "hysteria2":
        try:
            return _hysteria2(uri)
        except Exception:
            return None
    try:
        rec = merge.validate_uri(uri, {"vless", "vmess", "trojan", "ss"})
    except Exception:
        return None
    rec["uri"] = uri
    rec["remark"] = _remark_of(uri)
    return rec


def parse_subscription(text: str) -> tuple[list[dict], int]:
    """Текст подписки → (уникальные узлы, сколько ссылок было)."""
    uris = decode_payload(text)
    seen: set[str] = set()
    out: list[dict] = []
    for uri in uris:
        rec = parse_uri(uri)
        if not rec:
            continue
        fp = rec.get("fingerprint") or _fp(rec.get("proto", ""), rec.get("host", ""), str(rec.get("port", "")))
        if fp in seen:
            continue
        seen.add(fp)
        rec["fingerprint"] = fp
        out.append(rec)
    return out, len(uris)


def parse_userinfo(header: str) -> dict:
    """`upload=1; download=2; total=3; expire=4` → словарь чисел."""
    return merge.parse_userinfo(header or "")


def mask_secret(text: str, keep: int = 6) -> str:
    """Маскировка ссылок в логах: оставляем только края."""
    if len(text) <= keep * 2:
        return "•" * len(text)
    return f"{text[:keep]}…{text[-keep:]}"


def is_single_key(text: str) -> bool:
    return bool(re.match(r"^(vless|vmess|trojan|ss|hysteria2)://", text.strip(), re.I))
