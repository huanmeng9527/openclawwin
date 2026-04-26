from __future__ import annotations

from dataclasses import dataclass, field
from typing import Any


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
