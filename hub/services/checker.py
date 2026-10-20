"""Проверка узлов: TCP-коннект, TLS-рукопожатие, задержка.

Три уровня, как в ТЗ:
  * tcp_ok  — порт отвечает;
  * tls_ok  — рукопожатие проходит (для Reality/TLS);
  * alive   — узел годится для выдачи (TCP + TLS, либо UDP-протокол без проверки).
"""

from __future__ import annotations

import asyncio
import socket
import ssl
import time

from ..config import settings


async def _tcp(host: str, port: int, timeout: float) -> tuple[bool, int | None]:
    started = time.perf_counter()
    try:
        reader, writer = await asyncio.wait_for(asyncio.open_connection(host, port), timeout)
        writer.close()
        try:
            await writer.wait_closed()
        except Exception:
            pass
        del reader
        return True, int((time.perf_counter() - started) * 1000)
    except (asyncio.TimeoutError, OSError):
        return False, None


def _tls_sync(host: str, port: int, sni: str, timeout: float) -> bool:
    ctx = ssl.create_default_context()
    ctx.check_hostname = False
    ctx.verify_mode = ssl.CERT_NONE
    try:
        with socket.create_connection((host, port), timeout=timeout) as raw:
            with ctx.wrap_socket(raw, server_hostname=sni or host):
                return True
    except Exception:
        return False


async def _tls(host: str, port: int, sni: str, timeout: float) -> bool:
    return await asyncio.to_thread(_tls_sync, host, port, sni, timeout)


async def check_node(node: dict, attempts: int | None = None,
                     timeout: float | None = None) -> dict:
    """node: {proto, host, port, sni}. Возвращает флаги и задержку."""
    attempts = attempts or settings.check_attempts
    timeout = timeout or settings.check_timeout
    host, port = node.get("host", ""), int(node.get("port", 443) or 443)
    proto = node.get("proto", "vless")
    sni = node.get("sni") or host

    if not host:
        return {"tcp_ok": False, "tls_ok": False, "alive": False, "latency_ms": None}

    # Hysteria2 и другие UDP-протоколы по TCP не проверить: не врём и не исключаем.
    if proto == "hysteria2":
        return {"tcp_ok": False, "tls_ok": False, "alive": True,
                "latency_ms": None, "note": "udp"}

    tcp_ok, latency = False, None
    for _ in range(max(1, attempts)):
        tcp_ok, latency = await _tcp(host, port, timeout)
        if tcp_ok:
            break

    security = (node.get("security") or "").lower()
    needs_tls = security in {"tls", "reality", "xtls"}

    tls_ok = False
    if tcp_ok and needs_tls:
        tls_ok = await _tls(host, port, sni, timeout)

    # Открытый порт — ещё не рабочий ключ: именно на этом клиент показывает
    # «подключаюсь…» и висит. В выдачу идут только те, кто прошёл TLS.
    if proto in {"ss", "hysteria2"}:
        alive = tcp_ok
    elif needs_tls:
        alive = bool(tcp_ok and tls_ok)
    else:
        alive = tcp_ok

    return {"tcp_ok": tcp_ok, "tls_ok": tls_ok, "alive": alive, "latency_ms": latency}


async def check_many(nodes: list[dict], workers: int | None = None) -> list[dict]:
    workers = workers or settings.check_workers
    sem = asyncio.Semaphore(workers)

    async def run(node: dict) -> dict:
        async with sem:
            result = await check_node(node)
            return {**node, **result}

    return await asyncio.gather(*(run(n) for n in nodes))
