"""Шина логов для «Обновить всё»: SSE без внешних зависимостей."""

from __future__ import annotations

import asyncio
from collections import defaultdict


class LogBus:
    def __init__(self) -> None:
        self._subscribers: dict[str, list[asyncio.Queue]] = defaultdict(list)
        self._loop: asyncio.AbstractEventLoop | None = None
        self._done: set[str] = set()

    def bind_loop(self, loop: asyncio.AbstractEventLoop) -> None:
        self._loop = loop

    def subscribe(self, run_id: str) -> asyncio.Queue:
        queue: asyncio.Queue = asyncio.Queue()
        self._subscribers[run_id].append(queue)
        return queue

    def publish(self, run_id: str, line: str) -> None:
        """Вызывается из рабочего потока — перекидываем в event loop."""
        if self._loop is None:
            return
        for queue in list(self._subscribers.get(run_id, [])):
            self._loop.call_soon_threadsafe(queue.put_nowait, line)

    def finish(self, run_id: str, summary: str) -> None:
        self.publish(run_id, f"__done__ {summary}")
        self._done.add(run_id)

    def is_done(self, run_id: str) -> bool:
        return run_id in self._done

    def unsubscribe(self, run_id: str, queue: asyncio.Queue) -> None:
        if queue in self._subscribers.get(run_id, []):
            self._subscribers[run_id].remove(queue)


bus = LogBus()
