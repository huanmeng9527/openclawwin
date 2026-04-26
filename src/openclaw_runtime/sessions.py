from __future__ import annotations

import json
from dataclasses import dataclass, field
from datetime import datetime, timezone
from pathlib import Path
from uuid import uuid4

from .messaging import InternalMessage


@dataclass
class SessionRecord:
    session_key: str
    session_id: str
    agent_id: str
    private: bool
    channel: str
    peer_id: str
    group_id: str | None = None
    thread_id: str | None = None
    created_at: str = field(default_factory=lambda: datetime.now(timezone.utc).isoformat())
    updated_at: str = field(default_factory=lambda: datetime.now(timezone.utc).isoformat())
    metadata: dict[str, str] = field(default_factory=dict)

    def to_dict(self) -> dict[str, object]:
        return {
            "sessionKey": self.session_key,
            "sessionId": self.session_id,
            "agentId": self.agent_id,
            "private": self.private,
            "channel": self.channel,
            "peerId": self.peer_id,
            "groupId": self.group_id,
            "threadId": self.thread_id,
            "createdAt": self.created_at,
            "updatedAt": self.updated_at,
            "metadata": self.metadata,
        }

    @classmethod
    def from_dict(cls, data: dict[str, object]) -> "SessionRecord":
        return cls(
            session_key=str(data["sessionKey"]),
            session_id=str(data["sessionId"]),
            agent_id=str(data["agentId"]),
            private=bool(data["private"]),
            channel=str(data["channel"]),
            peer_id=str(data["peerId"]),
            group_id=data.get("groupId") if data.get("groupId") is None else str(data["groupId"]),
            thread_id=data.get("threadId") if data.get("threadId") is None else str(data["threadId"]),
            created_at=str(data["createdAt"]),
            updated_at=str(data["updatedAt"]),
            metadata={str(key): str(value) for key, value in dict(data.get("metadata", {})).items()},
        )


class SessionManager:
    def __init__(
        self,
        workspace: str | Path,
        *,
        agent_id: str = "default",
        dm_scope: str = "per-channel-peer",
    ) -> None:
        self.workspace = Path(workspace)
        self.agent_id = agent_id
        self.dm_scope = dm_scope
        self.root = self.workspace / ".openclaw" / "agents" / agent_id
        self.sessions_dir = self.root / "sessions"
        self.mapping_path = self.root / "sessions.json"
        self.sessions_dir.mkdir(parents=True, exist_ok=True)
        self._records = self._load_records()

    def resolve_message(self, message: InternalMessage) -> SessionRecord:
        session_key = self.session_key_for(message)
        record = self._records.get(session_key)
        now = datetime.now(timezone.utc).isoformat()
        if record is None:
            record = SessionRecord(
                session_key=session_key,
                session_id=uuid4().hex,
                agent_id=self.agent_id,
                private=message.is_private,
                channel=message.channel,
                peer_id=message.peer_id,
                group_id=message.group_id,
                thread_id=message.thread_id,
                created_at=now,
                updated_at=now,
            )
            self._records[session_key] = record
        else:
            record.updated_at = now
        self._save_records()
        return record

    def session_key_for(self, message: InternalMessage) -> str:
        if message.group_id is not None:
            key = f"agent:{self.agent_id}:{message.channel}:group:{message.group_id}"
            if message.thread_id is not None:
                key += f":thread:{message.thread_id}"
            return key
        if self.dm_scope == "main":
            return f"agent:{self.agent_id}:main"
        if self.dm_scope == "per-peer":
            return f"agent:{self.agent_id}:dm:{message.peer_id}"
        if self.dm_scope == "per-channel-peer":
            return f"agent:{self.agent_id}:{message.channel}:dm:{message.peer_id}"
        raise ValueError(f"unknown dm_scope: {self.dm_scope}")

    def session_key_for_cron(self, job_id: str) -> str:
        return f"cron:{job_id}"

    def session_key_for_subagent(self, subagent_id: str) -> str:
        return f"agent:{self.agent_id}:subagent:{subagent_id}"

    def append_transcript(
        self,
        record: SessionRecord,
        role: str,
        content: str,
        *,
        metadata: dict[str, object] | None = None,
    ) -> None:
        payload = {
            "ts": datetime.now(timezone.utc).isoformat(),
            "role": role,
            "content": content,
            "metadata": metadata or {},
        }
        with self.transcript_path(record).open("a", encoding="utf-8") as file:
            file.write(json.dumps(payload, ensure_ascii=False, sort_keys=True) + "\n")

    def read_transcript(self, record: SessionRecord, *, limit: int | None = None) -> list[dict[str, object]]:
        path = self.transcript_path(record)
        if not path.exists():
            return []
        lines = path.read_text(encoding="utf-8").splitlines()
        if limit is not None:
            lines = lines[-limit:]
        return [json.loads(line) for line in lines if line.strip()]

    def transcript_path(self, record: SessionRecord) -> Path:
        return self.sessions_dir / f"{record.session_id}.jsonl"

    def _load_records(self) -> dict[str, SessionRecord]:
        if not self.mapping_path.exists():
            return {}
        data = json.loads(self.mapping_path.read_text(encoding="utf-8"))
        return {
            str(key): SessionRecord.from_dict(value)
            for key, value in dict(data.get("sessions", {})).items()
        }

    def _save_records(self) -> None:
        self.root.mkdir(parents=True, exist_ok=True)
        payload = {
            "agentId": self.agent_id,
            "sessions": {
                key: record.to_dict()
                for key, record in sorted(self._records.items())
            },
        }
        self.mapping_path.write_text(
            json.dumps(payload, ensure_ascii=False, indent=2, sort_keys=True),
            encoding="utf-8",
        )
