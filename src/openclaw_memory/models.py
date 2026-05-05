from __future__ import annotations

from dataclasses import dataclass, field
from datetime import datetime, timezone
from typing import Any
from uuid import uuid4


KIND_PREFIXES = {
    "W": "world",
    "B": "experience",
    "O": "opinion",
    "S": "observation",
}

PREFIX_BY_KIND = {value: key for key, value in KIND_PREFIXES.items()}

CANONICAL_KINDS = frozenset(KIND_PREFIXES.values())


@dataclass(frozen=True)
class Fact:
    id: str
    kind: str
    content: str
    entities: tuple[str, ...] = field(default_factory=tuple)
    source_path: str = ""
    source_line: int = 1
    timestamp: str | None = None
    confidence: float | None = None
    metadata: dict[str, Any] = field(default_factory=dict)

    @property
    def source(self) -> str:
        return f"{self.source_path}#L{self.source_line}"

    @property
    def prefix(self) -> str:
        return PREFIX_BY_KIND.get(self.kind, "S")

    def to_dict(self) -> dict[str, Any]:
        return {
            "id": self.id,
            "kind": self.kind,
            "timestamp": self.timestamp,
            "entities": list(self.entities),
            "content": self.content,
            "source": self.source,
            "confidence": self.confidence,
        }


@dataclass(frozen=True)
class RecallResult:
    fact: Fact
    score: float | None = None

    def to_dict(self) -> dict[str, Any]:
        payload = self.fact.to_dict()
        payload["score"] = self.score
        return payload


MEMORY_LAYERS = frozenset({"working", "session", "semantic", "procedural"})


@dataclass(frozen=True)
class MemoryRecord:
    id: str
    layer: str
    namespace: str = "default"
    scope: str = "global"
    session_id: str | None = None
    agent_id: str | None = None
    user_id: str | None = None
    key: str | None = None
    title: str = ""
    content: str = ""
    tags: tuple[str, ...] = field(default_factory=tuple)
    metadata: dict[str, Any] = field(default_factory=dict)
    source: str = ""
    confidence: float = 1.0
    created_at: str = field(default_factory=lambda: utc_now())
    updated_at: str = field(default_factory=lambda: utc_now())
    expires_at: str | None = None
    visibility: str = "private"
    risk_level: str = "low"

    def __post_init__(self) -> None:
        if self.layer not in MEMORY_LAYERS:
            raise ValueError(f"unknown memory layer: {self.layer}")
        object.__setattr__(self, "tags", tuple(dict.fromkeys(self.tags)))

    @classmethod
    def create(
        cls,
        *,
        layer: str,
        content: str,
        namespace: str = "default",
        scope: str = "global",
        session_id: str | None = None,
        agent_id: str | None = None,
        user_id: str | None = None,
        key: str | None = None,
        title: str = "",
        tags: tuple[str, ...] | list[str] = (),
        metadata: dict[str, Any] | None = None,
        source: str = "",
        confidence: float = 1.0,
        expires_at: str | None = None,
        visibility: str = "private",
        risk_level: str = "low",
        id: str | None = None,
    ) -> "MemoryRecord":
        now = utc_now()
        return cls(
            id=id or uuid4().hex,
            layer=layer,
            namespace=namespace,
            scope=scope,
            session_id=session_id,
            agent_id=agent_id,
            user_id=user_id,
            key=key,
            title=title,
            content=content,
            tags=tuple(tags),
            metadata=metadata or {},
            source=source,
            confidence=confidence,
            created_at=now,
            updated_at=now,
            expires_at=expires_at,
            visibility=visibility,
            risk_level=risk_level,
        )

    def with_updates(self, **updates: Any) -> "MemoryRecord":
        payload = self.to_dict()
        payload.update(updates)
        payload["updated_at"] = updates.get("updated_at", utc_now())
        return MemoryRecord.from_dict(payload)

    def to_dict(self) -> dict[str, Any]:
        return {
            "id": self.id,
            "layer": self.layer,
            "namespace": self.namespace,
            "scope": self.scope,
            "session_id": self.session_id,
            "agent_id": self.agent_id,
            "user_id": self.user_id,
            "key": self.key,
            "title": self.title,
            "content": self.content,
            "tags": list(self.tags),
            "metadata": self.metadata,
            "source": self.source,
            "confidence": self.confidence,
            "created_at": self.created_at,
            "updated_at": self.updated_at,
            "expires_at": self.expires_at,
            "visibility": self.visibility,
            "risk_level": self.risk_level,
        }

    @classmethod
    def from_dict(cls, data: dict[str, Any]) -> "MemoryRecord":
        return cls(
            id=str(data["id"]),
            layer=str(data["layer"]),
            namespace=str(data.get("namespace") or "default"),
            scope=str(data.get("scope") or "global"),
            session_id=optional_str(data.get("session_id")),
            agent_id=optional_str(data.get("agent_id")),
            user_id=optional_str(data.get("user_id")),
            key=optional_str(data.get("key")),
            title=str(data.get("title") or ""),
            content=str(data.get("content") or ""),
            tags=tuple(str(tag) for tag in data.get("tags", ())),
            metadata=dict(data.get("metadata") or {}),
            source=str(data.get("source") or ""),
            confidence=float(data.get("confidence", 1.0)),
            created_at=str(data.get("created_at") or utc_now()),
            updated_at=str(data.get("updated_at") or utc_now()),
            expires_at=optional_str(data.get("expires_at")),
            visibility=str(data.get("visibility") or "private"),
            risk_level=str(data.get("risk_level") or "low"),
        )


@dataclass(frozen=True)
class MemorySearchResult:
    record: MemoryRecord
    score: float
    source: str
    reason: str

    @property
    def layer(self) -> str:
        return self.record.layer

    def to_dict(self) -> dict[str, Any]:
        payload = self.record.to_dict()
        payload.update(
            {
                "layer": self.record.layer,
                "score": self.score,
                "source": self.source,
                "reason": self.reason,
            }
        )
        return payload


def utc_now() -> str:
    return datetime.now(timezone.utc).isoformat()


def optional_str(value: Any) -> str | None:
    if value is None:
        return None
    return str(value)
