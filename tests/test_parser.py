"""Тесты разбора подписок и порядка выдачи."""

from __future__ import annotations

import base64

import pytest

from hub.services import parser, subscription

VLESS_REALITY = (
    "vless://739f3bf7-4a8a-4a1b-bdc6-fb3a00123ce3@130.49.189.158:45433"
    "?type=tcp&security=reality&pbk=dfJb8gJq6IRsE1KMsfZp5tNLiwBNQMbSl5NF1z5dq3c"
    "&sid=5f203fdf&fp=chrome&sni=addons.mozilla.org&flow=xtls-rprx-vision#vless-45433"
)

VLESS_WS = (
    "vless://11111111-2222-3333-4444-555555555555@example.com:443"
    "?type=ws&security=tls&sni=example.com&path=%2Fws#node-ws"
)

HY2 = "hysteria2://secret@hy.example.com:8443?sni=hy.example.com#hy-node"

SS = (
    "ss://Y2hhY2hhMjAtaWV0Zi1wb2x5MTMwNTpNWWtNL2I1d3c2S2h5SGpCS0I2T1ppZnF6Y1hFbkRUMmpESUJXeXdZQXdzPQ=="
    "@130.49.189.158:43558#outline-ss"
)


def test_parse_vless_reality_keeps_core_fields():
    rec = parser.parse_uri(VLESS_REALITY)
    assert rec is not None
    assert rec["proto"] == "vless"
    assert rec["host"] == "130.49.189.158"
    assert rec["port"] == 45433
    assert rec["sni"] == "addons.mozilla.org"
    assert rec["pbk"].startswith("dfJb8gJq")
    assert rec["remark"] == "vless-45433"


def test_parse_ws_and_hysteria2_and_ss():
    ws = parser.parse_uri(VLESS_WS)
    assert ws["network"] == "ws" and ws["path"] == "/ws"

    hy = parser.parse_uri(HY2)
    assert hy["proto"] == "hysteria2"
    assert hy["port"] == 8443
    assert hy["auth"] == "secret"

    ss = parser.parse_uri(SS)
    assert ss["proto"] == "ss"
    assert ss["port"] == 43558


def test_unknown_scheme_is_ignored():
    assert parser.parse_uri("http://example.com") is None
    assert parser.parse_uri("не ссылка") is None


def test_subscription_dedupes_by_fingerprint():
    text = "\n".join([VLESS_REALITY, VLESS_REALITY, VLESS_WS])
    nodes, raw = parser.parse_subscription(text)
    assert raw == 3
    assert len(nodes) == 2


def test_base64_and_plain_payloads_are_equal():
    text = "\n".join([VLESS_REALITY, HY2])
    encoded = base64.b64encode(text.encode()).decode()
    assert len(parser.parse_subscription(encoded)[0]) == 2
    assert len(parser.parse_subscription(text)[0]) == 2


def test_whitelist_mode_changes_order():
    normal = subscription.order_for(subscription.MODE_NORMAL)
    white = subscription.order_for(subscription.MODE_WHITELIST)
    assert normal == ["own_vps", "trial", "public"]
    assert white[:2] == ["bridge_ru", "cdn_xhttp"]
    assert white[-1] == "public"


def test_label_marks_public_sources():
    class Src:
        kind = "public"
        name = "Сборник"

    class Rec:
        remark = "node-1"
        host = "1.2.3.4"
        port = 443

    label = subscription._label(Rec(), Src())
    assert "не для банков" in label


def test_mask_hides_most_of_the_link():
    assert parser.mask_secret("vless://very-secret-token-value").startswith("vless:")
    assert "secret" not in parser.mask_secret("vless://very-secret-token-value")
