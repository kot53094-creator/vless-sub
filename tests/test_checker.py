"""Тесты проверки узлов: живой порт, закрытый порт, UDP-протокол."""

from __future__ import annotations

import asyncio
import socket

import pytest

from hub.services import checker


async def _serve(port_holder: dict):
    async def handler(reader, writer):
        writer.close()

    server = await asyncio.start_server(handler, "127.0.0.1", 0)
    port_holder["port"] = server.sockets[0].getsockname()[1]
    async with server:
        await asyncio.sleep(5)


def _free_port() -> int:
    with socket.socket() as sock:
        sock.bind(("127.0.0.1", 0))
        return sock.getsockname()[1]


@pytest.mark.asyncio
async def test_open_port_is_alive():
    holder: dict = {}
    task = asyncio.create_task(_serve(holder))
    await asyncio.sleep(0.2)
    try:
        result = await checker.check_node(
            {"proto": "vless", "host": "127.0.0.1", "port": holder["port"], "security": "none"},
            attempts=1, timeout=2)
        assert result["tcp_ok"] is True
        assert result["alive"] is True
        assert result["latency_ms"] is not None
    finally:
        task.cancel()


@pytest.mark.asyncio
async def test_closed_port_is_dead():
    result = await checker.check_node(
        {"proto": "vless", "host": "127.0.0.1", "port": _free_port(), "security": "none"},
        attempts=1, timeout=1)
    assert result["tcp_ok"] is False
    assert result["alive"] is False


@pytest.mark.asyncio
async def test_hysteria2_is_not_marked_dead_by_tcp():
    """UDP-узлы нельзя судить по TCP: не исключаем их из выдачи."""
    result = await checker.check_node(
        {"proto": "hysteria2", "host": "127.0.0.1", "port": _free_port()},
        attempts=1, timeout=1)
    assert result["alive"] is True
    assert result.get("note") == "udp"
