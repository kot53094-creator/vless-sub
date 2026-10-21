"""Проверка ключей: TCP-порт + TLS. Без туннеля — не тратим слоты устройств."""

from __future__ import annotations

import socket
import ssl
import time
from dataclasses import dataclass

from .parser import ParsedKey


@dataclass(slots=True)
class CheckResult:
    alive: bool | None
    latency_ms: int | None = None
    error: str = ""
    detail: str = ""


def _tcp(host: str, port: int, timeout: float) -> int:
    started = time.perf_counter()
    with socket.create_connection((host, port), timeout=timeout):
        pass
    return int((time.perf_counter() - started) * 1000)


def _tls(host: str, port: int, sni: str, timeout: float) -> int:
    context = ssl.create_default_context()
    context.check_hostname = False
    context.verify_mode = ssl.CERT_NONE
    started = time.perf_counter()
    with socket.create_connection((host, port), timeout=timeout) as sock:
        with context.wrap_socket(sock, server_hostname=sni or host):
            pass
    return int((time.perf_counter() - started) * 1000)


def check_key(key: ParsedKey, timeout: float = 5.0, attempts: int = 2) -> CheckResult:
    last_error = ""
    for attempt in range(attempts):
        try:
            if key.is_udp:
                # Hysteria2 работает по UDP: без клиента проверяем только резолв.
                socket.getaddrinfo(key.host, key.port, proto=socket.IPPROTO_UDP)
                return CheckResult(alive=None, detail="udp", error="UDP: доступность не проверяется")
            tcp_ms = _tcp(key.host, key.port, timeout)
            if key.is_reality:
                return CheckResult(True, tcp_ms, detail="reality")
            if key.is_tls:
                return CheckResult(True, max(tcp_ms, _tls(key.host, key.port, key.params.get("sni", ""), timeout)),
                                   detail="tls")
            return CheckResult(True, tcp_ms, detail="tcp")
        except (socket.timeout, TimeoutError):
            last_error = f"нет ответа за {timeout:g} с"
        except ssl.SSLError as exc:
            last_error = f"TLS: {exc.reason or exc}"
        except socket.gaierror as exc:
            last_error = f"адрес не найден: {exc}"
        except OSError as exc:
            last_error = f"сеть: {exc}"
        if attempt + 1 < attempts:
            time.sleep(0.3)
    return CheckResult(False, None, last_error or "не отвечает")
