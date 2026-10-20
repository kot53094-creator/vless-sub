"""Тесты клиента Remnawave на поддельном транспорте (без сети)."""

from __future__ import annotations

from datetime import datetime, timedelta, timezone

import httpx
import pytest

from hub.services.remnawave import Remnawave, RemnawaveError

BASE = "https://panel.example.com"


def _client(handler, token: str = "tok") -> Remnawave:
    return Remnawave(base=BASE, token=token, transport=httpx.MockTransport(handler))


def _users_payload() -> dict:
    soon = (datetime.now(timezone.utc) + timedelta(days=3)).isoformat()
    return {
        "response": {
            "users": [
                {
                    "uuid": "11111111-aaaa", "username": "alice", "status": "ACTIVE",
                    "usedTrafficBytes": 95, "trafficLimitBytes": 100,
                    "expireAt": soon, "hwidDeviceLimit": 3,
                    "hwidDevices": [{"hwid": "d1"}, {"hwid": "d2"}],
                    "subscriptionUrl": "https://panel.example.com/sub/alice",
                },
                {
                    "uuid": "22222222-bbbb", "username": "bob", "status": "DISABLED",
                    "usedTrafficBytes": 0, "trafficLimitBytes": 0,
                },
            ]
        }
    }


@pytest.mark.asyncio
async def test_users_are_parsed_and_sorted():
    def handler(request: httpx.Request) -> httpx.Response:
        assert request.headers["Authorization"] == "Bearer tok"
        assert request.url.path == "/api/users"
        return httpx.Response(200, json=_users_payload())

    users = await _client(handler).users()
    assert [u.username for u in users] == ["bob", "alice"]  # проблемный наверх
    alice = next(u for u in users if u.username == "alice")
    assert alice.devices == 2
    assert alice.limit_bytes == 100
    assert alice.traffic_pct == 95.0
    assert alice.level == "warn"          # 95% и 3 дня — жёлтый
    bob = next(u for u in users if u.username == "bob")
    assert bob.level == "bad"             # DISABLED
    assert bob.limit_bytes is None        # 0 → без лимита


@pytest.mark.asyncio
async def test_bad_token_is_reported_clearly():
    def handler(request: httpx.Request) -> httpx.Response:
        return httpx.Response(401, json={"message": "unauthorized"})

    with pytest.raises(RemnawaveError) as err:
        await _client(handler).users()
    assert "401" in str(err.value)


@pytest.mark.asyncio
async def test_devices_are_parsed():
    def handler(request: httpx.Request) -> httpx.Response:
        assert request.url.path == "/api/hwid/devices/11111111-aaaa"
        return httpx.Response(200, json={"response": {"devices": [{
            "hwid": "abcdef1234567890", "platform": "Android", "osVersion": "14",
            "deviceModel": "Pixel 7", "createdAt": "2026-10-01T10:00:00Z",
            "updatedAt": "2026-10-20T18:30:00Z", "ip": "1.2.3.4", "country": "RU",
        }]}})

    devices = await _client(handler).devices("11111111-aaaa")
    assert len(devices) == 1
    assert devices[0].model == "Pixel 7"
    assert devices[0].country == "RU"
    assert devices[0].first_seen.year == 2026


@pytest.mark.asyncio
async def test_delete_device_uses_expected_path():
    seen: list[tuple[str, str]] = []

    def handler(request: httpx.Request) -> httpx.Response:
        seen.append((request.method, request.url.path))
        return httpx.Response(204)

    await _client(handler).delete_device("abcdef1234567890")
    assert seen == [("DELETE", "/api/hwid/devices/abcdef1234567890")]


@pytest.mark.asyncio
async def test_not_configured_raises_instead_of_silent_empty():
    client = Remnawave(base="", token="")
    with pytest.raises(RemnawaveError):
        await client.users()
    ok, message = await client.ping()
    assert ok is False
    assert "не настроена" in message


@pytest.mark.asyncio
async def test_network_error_is_wrapped():
    def handler(request: httpx.Request) -> httpx.Response:
        raise httpx.ConnectError("boom")

    with pytest.raises(RemnawaveError) as err:
        await _client(handler).users()
    assert "нет связи" in str(err.value)
