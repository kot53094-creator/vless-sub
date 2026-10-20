"""Загрузка подписок с заголовками, которые отдают панели."""

from __future__ import annotations

import httpx

from ..config import settings


class FetchResult:
    __slots__ = ("text", "headers", "status", "error")

    def __init__(self, text: str = "", headers: dict | None = None,
                 status: int = 0, error: str = "") -> None:
        self.text = text
        self.headers = headers or {}
        self.status = status
        self.error = error

    @property
    def ok(self) -> bool:
        return self.status == 200 and bool(self.text) and not self.error

    def header(self, name: str) -> str:
        return self.headers.get(name.lower(), "")


async def fetch_source(url: str, ua: str | None = None) -> FetchResult:
    """GET подписки. Таймаут, UA как у Happ, редиректы разрешены."""
    headers = {
        "User-Agent": ua or settings.user_agent,
        "Accept": "*/*",
        "Accept-Encoding": "identity",
    }
    try:
        async with httpx.AsyncClient(follow_redirects=True, timeout=settings.fetch_timeout) as client:
            resp = await client.get(url, headers=headers)
            hdrs = {k.lower(): v for k, v in resp.headers.items()}
            if resp.status_code != 200:
                return FetchResult(status=resp.status_code,
                                   error=f"HTTP {resp.status_code}", headers=hdrs)
            return FetchResult(text=resp.text, headers=hdrs, status=resp.status_code)
    except httpx.TimeoutException:
        return FetchResult(error="таймаут")
    except httpx.HTTPError as exc:
        return FetchResult(error=f"{type(exc).__name__}: {exc}"[:200])
    except Exception as exc:  # noqa: BLE001 - сеть бывает любой
        return FetchResult(error=f"{type(exc).__name__}: {exc}"[:200])
