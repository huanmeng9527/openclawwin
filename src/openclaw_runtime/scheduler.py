from __future__ import annotations

from dataclasses import dataclass, field
from datetime import datetime, timedelta, timezone
from typing import Callable
from uuid import uuid4


@dataclass
class ScheduledJob:
    id: str
    kind: str
    prompt: str
    next_run_at: datetime
    every: timedelta | None = None
    announce_to: str | None = None
    metadata: dict[str, str] = field(default_factory=dict)


class CronScheduler:
    def __init__(self) -> None:
        self._jobs: dict[str, ScheduledJob] = {}

    def add_every(self, prompt: str, every: timedelta, *, job_id: str | None = None) -> str:
        identifier = job_id or uuid4().hex
        self._jobs[identifier] = ScheduledJob(
            id=identifier,
            kind="agentTurn",
            prompt=prompt,
            next_run_at=datetime.now(timezone.utc) + every,
            every=every,
        )
        return identifier

    def add_at(self, prompt: str, run_at: datetime, *, job_id: str | None = None) -> str:
        identifier = job_id or uuid4().hex
        self._jobs[identifier] = ScheduledJob(
            id=identifier,
            kind="agentTurn",
            prompt=prompt,
            next_run_at=run_at,
        )
        return identifier

    def run_due(self, handler: Callable[[ScheduledJob], str], *, now: datetime | None = None) -> list[str]:
        current = now or datetime.now(timezone.utc)
        outputs: list[str] = []
        for job in list(self._jobs.values()):
            if job.next_run_at > current:
                continue
            outputs.append(handler(job))
            if job.every is None:
                del self._jobs[job.id]
            else:
                job.next_run_at = current + job.every
        return outputs


class HeartbeatSystem:
    def __init__(self, prompt: str = "Run heartbeat checks.", *, every: timedelta | None = None) -> None:
        self.prompt = prompt
        self.every = every or timedelta(minutes=30)
        self.next_run_at = datetime.now(timezone.utc) + self.every

    def tick(self, handler: Callable[[str], str], *, now: datetime | None = None) -> str | None:
        current = now or datetime.now(timezone.utc)
        if current < self.next_run_at:
            return None
        self.next_run_at = current + self.every
        output = handler(self.prompt)
        if output.strip() in {"HEARTBEAT_OK", "NO_REPLY", ""}:
            return None
        return output
