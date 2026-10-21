"""Разбор ссылок и подписок."""

from __future__ import annotations

import base64

import pytest

from app.services.parser import (
    is_single_key,
    parse_subscription,
    parse_uri,
    parse_userinfo,
    to_base64,
)

VLESS = "vless://11111111-1111-1111-1111-111111111111@203.0.113.10:443?security=reality&sni=www.microsoft.com#DE"
TROJAN = "trojan://pass@example.com:8443?security=tls&sni=example.com#NL"
HY2 = "hy2://pass@example.org:443?sni=example.org#FI"


def test_parse_vless_reality():
    key = parse_uri(VLESS)
    assert key is not None
    assert key.proto == "vless"
    assert key.host == "203.0.113.10"
    assert key.port == 443
    assert key.security == "reality"
    assert key.is_reality is True


def test_parse_trojan_and_hysteria2():
    assert parse_uri(TROJAN).port == 8443
    assert parse_uri(HY2).proto == "hysteria2"
    assert parse_uri(HY2).is_udp is True


def test_rejects_garbage():
    assert parse_uri("https://example.com/sub") is None
    assert parse_uri("не ссылка") is None
    assert parse_uri("vless://") is None


def test_plain_subscription_with_comments_and_duplicates():
    body = f"# comment\n{VLESS}\n{TROJAN}\n{VLESS}\n"
    keys = parse_subscription(body)
    assert len(keys) == 2


def test_base64_subscription():
    body = base64.b64encode(f"{VLESS}\n{TROJAN}".encode()).decode()
    assert len(parse_subscription(body)) == 2


def test_limit_is_respected():
    lines = "\n".join(VLESS.replace("203.0.113.10", f"203.0.113.{i}") for i in range(1, 11))
    assert len(parse_subscription(lines, limit=3)) == 3


def test_userinfo_header():
    info = parse_userinfo("upload=1; download=2; total=3; expire=1700000000")
    assert info == {"upload": 1, "download": 2, "total": 3, "expire": 1700000000}
    assert parse_userinfo(None) == {"upload": None, "download": None, "total": None, "expire": None}
    assert parse_userinfo("total=abc")["total"] is None


def test_single_key_detection():
    assert is_single_key(VLESS) is True
    assert is_single_key("https://example.com/sub") is False


def test_base64_roundtrip():
    encoded = to_base64([VLESS, TROJAN])
    assert len(parse_subscription(encoded)) == 2
