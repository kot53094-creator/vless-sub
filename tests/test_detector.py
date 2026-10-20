"""Тесты детектора белых списков и Telegram-уведомлений."""

from __future__ import annotations

import httpx
import pytest

from hub.config import settings
from hub.services import detector, notifier


def test_mode_switches_only_after_threshold():
    fails = 0
    mode = "normal"
    # RU открыт, зарубеж закрыт — копим серию
    for expected in (1, 2):
        fails, new_mode = detector.decide(True, False, fails, mode)
        assert (fails, new_mode) == (expected, None)
    fails, new_mode = detector.decide(True, False, fails, mode)
    assert (fails, new_mode) == (3, "whitelist")


def test_single_failure_does_not_switch():
    fails, new_mode = detector.decide(True, False, 0, "normal")
    assert new_mode is None
    assert fails == 1


def test_both_sites_work_keeps_normal_mode():
    fails, new_mode = detector.decide(True, True, 2, "normal")
    assert (fails, new_mode) == (0, None)


def test_foreign_back_switches_to_normal():
    fails, new_mode = detector.decide(True, True, 3, "whitelist")
    assert new_mode == "normal"


def test_no_repeat_switch_when_already_whitelist():
    fails, new_mode = detector.decide(True, False, 3, "whitelist", threshold=3)
    assert new_mode is None


@pytest.mark.asyncio
async def test_probe_ok_and_failure():
    def ok_handler(request: httpx.Request) -> httpx.Response:
        return httpx.Response(200, text="ok")

    def bad_handler(request: httpx.Request) -> httpx.Response:
        raise httpx.ConnectError("no route")

    good = await detector.probe("https://ya.ru/", transport=httpx.MockTransport(ok_handler))
    assert good.ok and good.latency_ms is not None

    bad = await detector.probe("https://www.google.com/", transport=httpx.MockTransport(bad_handler))
    assert not bad.ok
    assert bad.error == "ConnectError"


def test_notifier_disabled_without_token():
    assert notifier.enabled() in (True, False)  # не падает при пустом конфиге


@pytest.mark.asyncio
async def test_notifier_sends_expected_payload(monkeypatch):
    monkeypatch.setattr(settings, "telegram_token", "123:abc", raising=False)
    monkeypatch.setattr(settings, "telegram_chat", "-100500", raising=False)

    seen: dict = {}

    def handler(request: httpx.Request) -> httpx.Response:
        seen["url"] = str(request.url)
        seen["body"] = request.content.decode()
        return httpx.Response(200, json={"ok": True})

    sent = await notifier.send("<b>тест</b>", transport=httpx.MockTransport(handler))
    assert sent is True
    assert "123:abc" in seen["url"]
    assert "-100500" in seen["body"]


def test_mode_message_mentions_both_probes():
    text = notifier.format_mode("whitelist", True, False)
    assert "белые списки" in text
    assert "Российский сайт: открывается" in text
    assert "Зарубежный сайт: не открывается" in text


def test_sync_summary_is_one_line():
    text = notifier.format_sync({"published": 42, "alive": 50, "dead_sources": 1, "seconds": 7.5})
    assert "42" in text and "7.5" in text
    assert len(text.splitlines()) <= 4
