"""Клиент Remnawave API.

Панель необязательна: если `REMNAWAVE_URL` пуст или она недоступна, хаб
продолжает работать с остальными источниками, а экран «Ключи» показывает
причину. Пути вынесены в константы и переопределяются через
`REMNAWAVE_PATHS_JSON`, потому что в разных версиях панели они отличались.
"""

from __future__ import annotations

import json
import os
from dataclasses import dataclass, field
from datetime import datetime, timezone

import httpx

from ..config import settings


def _now() -> datetime:
    return datetime.now(timezone.utc)


DEFAULT_PATHS = {
    "users": "/api/users",
    "user": "/api/users/{uuid}",
    "devices": "/api/hwid/devices/{uuid}",
    "delete_device": "/api/hwid/devices/{device_id}",
    "reset_traffic": "/api/users/{uuid}/actions/reset-traffic",
    "revoke": "/api/users/{uuid}/actions/revoke",
    "update": "/api/users",
}


class RemnawaveError(RuntimeError):
    pass


@dataclass
class RwUser:
    uuid: str
    username: str
    status: str
    used_bytes: int = 0
    limit_bytes: int | None = None
    expire_at: datetime | None = None
    hwid_limit: int | None = None
    devices: int = 0
    subscription_url: str = ""

    @property
    def days_left(self) -> int | None:
        if not self.expire_at:
            return None
        return (self.expire_at - _now()).days

    @property
    def traffic_pct(self) -> float:
        if not self.limit_bytes:
            return 0.0
        return min(100.0, self.used_bytes / self.limit_bytes * 100)

    @property
    def level(self) -> str:
        """Подсветка строки: ok / warn / bad."""
        if self.status.upper() not in {"ACTIVE", "LIMITED"}:
            return "bad"
        if self.limit_bytes and self.used_bytes >= self.limit_bytes:
            return "bad"
        if self.days_left is not None and self.days_left < 0:
            return "bad"
        if (self.limit_bytes and self.traffic_pct >= 80) or (
                self.days_left is not None and self.days_left < 7):
            return "warn"
        return "ok"


@dataclass
class RwDevice:
    hwid: str
    platform: str = ""
    os_version: str = ""
    model: str = ""
    first_seen: datetime | None = None
    last_seen: datetime | None = None
    ip: str = ""
    country: str = ""


def _dt(value) -> datetime | None:
    if not value:
        return None
    if isinstance(value, datetime):
        return value
    try:
        text = str(value).replace("Z", "+00:00")
        return datetime.fromisoformat(text)
    except ValueError:
        return None


def _first(data: dict, *keys, default=None):
    for key in keys:
        if key in data and data[key] is not None:
            return data[key]
    return default


class Remnawave:
    def __init__(self, base: str | None = None, token: str | None = None, transport=None):
        self.base = (base if base is not None else settings.remnawave_url).rstrip("/")
        self.token = token if token is not None else settings.remnawave_token
        self._transport = transport
        self.paths = dict(DEFAULT_PATHS)
        override = os.getenv("REMNAWAVE_PATHS_JSON", "")
        if override:
            try:
                self.paths.update(json.loads(override))
            except json.JSONDecodeError:
                pass

    @property
    def configured(self) -> bool:
        return bool(self.base and self.token)

    def _headers(self) -> dict:
        return {
            "Authorization": f"Bearer {self.token}",
            "Accept": "application/json",
            "Content-Type": "application/json",
        }

    async def _request(self, method: str, path: str, **kwargs) -> dict:
        if not self.configured:
            raise RemnawaveError("Remnawave не настроена: задайте REMNAWAVE_URL и REMNAWAVE_TOKEN")
        url = f"{self.base}{path}"
        try:
            async with httpx.AsyncClient(timeout=20, verify=True, transport=self._transport) as client:
                resp = await client.request(method, url, headers=self._headers(), **kwargs)
        except httpx.HTTPError as exc:
            raise RemnawaveError(f"нет связи с панелью: {type(exc).__name__}") from exc

        if resp.status_code in (401, 403):
            raise RemnawaveError("панель отклонила токен (401/403)")
        if resp.status_code >= 400:
            raise RemnawaveError(f"панель ответила HTTP {resp.status_code}")
        if not resp.content:
            return {}
        try:
            return resp.json()
        except ValueError:
            return {}

    # ---- чтение
    async def ping(self) -> tuple[bool, str]:
        if not self.configured:
            return False, "не настроена (нет REMNAWAVE_URL / REMNAWAVE_TOKEN)"
        try:
            await self._request("GET", self.paths["users"], params={"size": 1})
            return True, "на связи"
        except RemnawaveError as exc:
            return False, str(exc)

    async def users(self) -> list[RwUser]:
        payload = await self._request("GET", self.paths["users"], params={"size": 500})
        body = payload.get("response", payload)
        raw = _first(body, "users", "items", default=body if isinstance(body, list) else [])
        out: list[RwUser] = []
        for item in raw or []:
            if not isinstance(item, dict):
                continue
            used = int(_first(item, "usedTrafficBytes", "usedBytes", "trafficUsedBytes", default=0) or 0)
            limit_raw = _first(item, "trafficLimitBytes", "limitBytes", "trafficLimit", default=None)
            limit = int(limit_raw) if limit_raw not in (None, "", 0) else None
            devices = item.get("hwidDevices") or item.get("devices") or []
            out.append(RwUser(
                uuid=str(_first(item, "uuid", "id", default="")),
                username=str(_first(item, "username", "name", default="без имени")),
                status=str(_first(item, "status", default="UNKNOWN")),
                used_bytes=used,
                limit_bytes=limit,
                expire_at=_dt(_first(item, "expireAt", "expiresAt", "expire")),
                hwid_limit=_first(item, "hwidDeviceLimit", "deviceLimit") or None,
                devices=len(devices) if isinstance(devices, list) else int(item.get("hwidDevicesCount") or 0),
                subscription_url=str(_first(item, "subscriptionUrl", "subUrl", default="")),
            ))
        out.sort(key=lambda u: (u.level != "bad", u.level != "warn", u.username.lower()))
        return out

    async def devices(self, user_uuid: str) -> list[RwDevice]:
        payload = await self._request("GET", self.paths["devices"].format(uuid=user_uuid))
        body = payload.get("response", payload)
        raw = _first(body, "devices", "items", "hwidDevices", default=body if isinstance(body, list) else [])
        out: list[RwDevice] = []
        for item in raw or []:
            if not isinstance(item, dict):
                continue
            out.append(RwDevice(
                hwid=str(_first(item, "hwid", "id", default="")),
                platform=str(_first(item, "platform", "os", default="")),
                os_version=str(_first(item, "osVersion", "version", default="")),
                model=str(_first(item, "deviceModel", "model", default="")),
                first_seen=_dt(_first(item, "createdAt", "firstSeen")),
                last_seen=_dt(_first(item, "updatedAt", "lastSeen", "lastConnectedAt")),
                ip=str(_first(item, "ip", "ipAddress", default="")),
                country=str(_first(item, "country", "countryCode", default="")),
            ))
        return out

    # ---- действия
    async def delete_device(self, device_id: str) -> None:
        await self._request("DELETE", self.paths["delete_device"].format(device_id=device_id))

    async def reset_traffic(self, user_uuid: str) -> None:
        await self._request("POST", self.paths["reset_traffic"].format(uuid=user_uuid))

    async def revoke_subscription(self, user_uuid: str) -> None:
        await self._request("POST", self.paths["revoke"].format(uuid=user_uuid))

    async def set_status(self, user_uuid: str, status: str) -> None:
        await self._request("PATCH", self.paths["update"], json={"uuid": user_uuid, "status": status})
