from __future__ import annotations

import threading
from dataclasses import dataclass, field
from typing import Callable, Generic, TypeVar
from uuid import uuid4


T = TypeVar("T")
R = TypeVar("R")


@dataclass(frozen=True)
class Command(Generic[T]):
    session_key: str
    payload: T
    lane: str = "session"
    id: str = field(default_factory=lambda: uuid4().hex)


class LaneAwareCommandQueue:
    def __init__(self, *, max_concurrent: int = 4, subagent_concurrent: int = 8) -> None:
        self._global = threading.BoundedSemaphore(max_concurrent)
        self._subagent = threading.BoundedSemaphore(subagent_concurrent)
        self._session_locks: dict[str, threading.RLock] = {}
        self._guard = threading.Lock()

    def dispatch(self, command: Command[T], handler: Callable[[Command[T]], R]) -> R:
        lane_lock = self._lock_for(command)
        with self._global:
            with lane_lock:
                return handler(command)

    def _lock_for(self, command: Command[T]) -> threading.RLock | threading.BoundedSemaphore:
        if command.lane == "subagent":
            return self._subagent
        if command.lane == "cron":
            return threading.RLock()
        with self._guard:
            if command.session_key not in self._session_locks:
                self._session_locks[command.session_key] = threading.RLock()
            return self._session_locks[command.session_key]
