"""Клиент Remnawave.

Пути и поля у разных версий панели отличаются, поэтому:
  • путь каждого метода можно переопределить переменной окружения RW_PATH_*;
  • ответы читаются терпимо (несколько вариантов имён полей);
  • ошибка всегда содержит метод, путь и код — видно, что именно не сошлось.
"""

from __future__ import annotations

import os
from dataclasses import dataclass, field
from datetime import datetime, timezone

import httpx

from ..config import settings

DEFAULT_PATHS = {
    "users": os.getenv("RW_PATH_USERS", "/api/users"),
    "user": os.getenv("RW_PATH_USER", "/api/users/{uuid}"),
    "devices": os.getenv("RW_PATH_DEVICES", "/api/hwid/devices/{uuid}"),
    "delete_device": os.getenv("RW_PATH_DELETE_DEVICE", "/api/hwid/devices/{hwid}"),
    "reset_traffic": os.getenv("RW_PATH_RESET_TRAFFIC", "/api/users/{uuid}/actions/reset-traffic"),
    "revoke": os.getenv("RW_PATH_REVOKE", "/api/users/{uuid}/actions/revoke"),
    "squads": os.getenv("RW_PATH_SQUADS", "/api/internal-squads"),
}


class RemnawaveError(RuntimeError):
    pass


@dataclass(slots=True)
class RwUser:
    uuid: str
    username: str
    status: str = "ACTIVE"
    used_bytes: int = 0
    limit_bytes: int | None = None
    expire_at: datetime | None = None
    hwid_limit: int | None = None
    devices: int = 0
    squads: list[str] = field(default_factory=list)
    sub_url: str = ""
    online: bool = False

    @property
    def days_left(self) -> int | None:
        if not self.expire_at:
            return None
        return (self.expire_at - datetime.now(timezone.utc)).days

    @property
    def traffic_pct(self) -> float | None:
        if not self.limit_bytes:
            return None
        return min(100.0, 100.0 * self.used_bytes / self.limit_bytes)


@dataclass(slots=True)
class RwDevice:
    hwid: str
    platform: str = ""
    model: str = ""
    ip: str = ""
    first_at: datetime | None = None
    last_at: datetime | None = None


@dataclass(slots=True)
class RwSquad:
    uuid: str
    name: str


def _first(data: dict, *keys, default=None):
    for key in keys:
        if key in data and data[key] is not None:
            return data[key]
    return default


def _dt(value) -> datetime | None:
    if not value:
        return None
    try:
        text = str(value).replace("Z", "+00:00")
        moment = datetime.fromisoformat(text)
        return moment if moment.tzinfo else moment.replace(tzinfo=timezone.utc)
    except ValueError:
        return None


class Remnawave:
    def __init__(self, base: str | None = None, token: str | None = None,
                 paths: dict[str, str] | None = None) -> None:
        self.base = (base if base is not None else settings.remnawave_url).rstrip("/")
        self.token = token if token is not None else settings.remnawave_token
        self.paths = {**DEFAULT_PATHS, **(paths or {})}

    @property
    def configured(self) -> bool:
        return bool(self.base and self.token)

    def _headers(self) -> dict[str, str]:
        return {
            "Authorization": f"Bearer {self.token}",
            "Accept": "application/json",
            "Content-Type": "application/json",
        }

    async def _request(self, method: str, path: str, **kwargs) -> dict:
        url = f"{self.base}{path}"
        try:
            async with httpx.AsyncClient(timeout=20) as client:
                response = await client.request(method, url, headers=self._headers(), **kwargs)
        except httpx.HTTPError as exc:
            raise RemnawaveError(f"{method} {path}: нет связи ({type(exc).__name__})") from exc

        if response.status_code >= 400:
            body = response.text[:200].replace("\n", " ")
            raise RemnawaveError(f"{method} {path}: HTTP {response.status_code} {body}")
        if not response.content:
            return {}
        try:
            return response.json()
        except ValueError:
            return {}

    async def ping(self) -> tuple[bool, str]:
        try:
            payload = await self._request("GET", self.paths["users"], params={"size": 1})
        except RemnawaveError as exc:
            return False, str(exc)
        return True, f"отвечает, пользователей в ответе: {len(_first(payload, 'response', 'users', default=[]) or [])}"

    async def users(self) -> list[RwUser]:
        payload = await self._request("GET", self.paths["users"], params={"size": 500})
        body = _first(payload, "response", "data", default=payload)
        raw = _first(body, "users", "items", default=body if isinstance(body, list) else [])
        out: list[RwUser] = []
        for item in raw or []:
            if not isinstance(item, dict):
                continue
            out.append(RwUser(
                uuid=str(_first(item, "uuid", "id", default="")),
                username=str(_first(item, "username", "name", default="")),
                status=str(_first(item, "status", default="ACTIVE")),
                used_bytes=int(_first(item, "usedTrafficBytes", "trafficUsed", default=0) or 0),
                limit_bytes=_first(item, "trafficLimitBytes", "trafficLimit"),
                expire_at=_dt(_first(item, "expireAt", "expiresAt")),
                hwid_limit=_first(item, "hwidDeviceLimit", "deviceLimit"),
                devices=int(_first(item, "hwidDevicesCount", default=0) or 0),
                squads=[str(s) for s in (_first(item, "internalSquads", default=[]) or [])],
                sub_url=str(_first(item, "subscriptionUrl", "subUrl", default="") or ""),
                online=bool(_first(item, "isOnline", "online", default=False)),
            ))
        return out

    async def user(self, uuid: str) -> RwUser | None:
        payload = await self._request("GET", self.paths["user"].format(uuid=uuid))
        body = _first(payload, "response", default=payload)
        if not isinstance(body, dict):
            return None
        for user in await self.users():
            if user.uuid == uuid:
                return user
        return None

    async def create_user(self, username: str, expire_at: datetime, traffic_gb: int,
                          device_limit: int, squad: str = "") -> dict:
        body: dict = {
            "username": username,
            "expireAt": expire_at.astimezone(timezone.utc).isoformat().replace("+00:00", "Z"),
            "trafficLimitBytes": max(0, traffic_gb) * 1024 ** 3,
            "trafficLimitStrategy": "NO_RESET",
            "hwidDeviceLimit": device_limit,
            "status": "ACTIVE",
        }
        if squad:
            body["activeInternalSquads"] = [squad]
        payload = await self._request("POST", self.paths["users"], json=body)
        return _first(payload, "response", default=payload) or {}

    async def update_user(self, uuid: str, **fields) -> dict:
        payload = await self._request("PATCH", self.paths["user"].format(uuid=uuid), json=fields)
        return _first(payload, "response", default=payload) or {}

    async def reset_traffic(self, uuid: str) -> None:
        await self._request("POST", self.paths["reset_traffic"].format(uuid=uuid))

    async def revoke(self, uuid: str) -> None:
        await self._request("POST", self.paths["revoke"].format(uuid=uuid))

    async def devices(self, uuid: str) -> list[RwDevice]:
        payload = await self._request("GET", self.paths["devices"].format(uuid=uuid))
        body = _first(payload, "response", default=payload)
        raw = _first(body, "devices", "items", "hwidDevices", default=body if isinstance(body, list) else [])
        out: list[RwDevice] = []
        for item in raw or []:
            if not isinstance(item, dict):
                continue
            out.append(RwDevice(
                hwid=str(_first(item, "hwid", "id", default="")),
                platform=str(_first(item, "platform", "os", default="")),
                model=str(_first(item, "deviceModel", "model", default="")),
                ip=str(_first(item, "ip", "lastIp", default="")),
                first_at=_dt(_first(item, "createdAt", "firstConnectedAt")),
                last_at=_dt(_first(item, "updatedAt", "lastConnectedAt")),
            ))
        return out

    async def delete_device(self, hwid: str) -> None:
        await self._request("DELETE", self.paths["delete_device"].format(hwid=hwid))

    async def squads(self) -> list[RwSquad]:
        try:
            payload = await self._request("GET", self.paths["squads"])
        except RemnawaveError:
            return []
        body = _first(payload, "response", default=payload)
        raw = _first(body, "internalSquads", "squads", "items", default=body if isinstance(body, list) else [])
        return [
            RwSquad(uuid=str(_first(item, "uuid", "id", default="")),
                    name=str(_first(item, "name", default="")))
            for item in raw or [] if isinstance(item, dict)
        ]
