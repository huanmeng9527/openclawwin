from __future__ import annotations

from pathlib import Path
from typing import Any
from uuid import uuid4

from .markdown_store import MarkdownMemoryStore
from .models import MemoryRecord, MemorySearchResult
from .sqlite_fts_store import SQLiteFTSMemoryStore
from .stores import InMemoryMemoryStore, MemoryStore


class WorkingMemoryLayer:
    layer = "working"

    def __init__(self, store: MemoryStore | None = None) -> None:
        self.store = store or InMemoryMemoryStore()

    def add(
        self,
        content: str,
        *,
        session_id: str | None = None,
        agent_id: str | None = None,
        lane_id: str | None = None,
        title: str = "",
        tags: tuple[str, ...] = (),
        metadata: dict[str, Any] | None = None,
        expires_at: str | None = None,
    ) -> MemoryRecord:
        metadata = dict(metadata or {})
        if lane_id is not None:
            metadata["lane_id"] = lane_id
        record = MemoryRecord.create(
            layer=self.layer,
            content=content,
            session_id=session_id,
            agent_id=agent_id,
            scope=lane_id or "session",
            title=title,
            tags=tags,
            metadata=metadata,
            source="working-memory",
            expires_at=expires_at,
        )
        return self.store.put(record)

    def put(self, record: MemoryRecord) -> MemoryRecord:
        return self.store.put(record)

    def get(self, id: str) -> MemoryRecord | None:
        return self.store.get(id)

    def search(self, query: str, filters: dict[str, Any] | None = None, limit: int = 10) -> list[MemorySearchResult]:
        return self.store.search(query, self._filters(filters), limit)

    def clear(self, filters: dict[str, Any] | None = None) -> int:
        return self.store.clear(self._filters(filters))

    def delete(self, id: str) -> bool:
        return self.store.delete(id)

    def list(self, filters: dict[str, Any] | None = None, limit: int = 100) -> list[MemoryRecord]:
        return self.store.list(self._filters(filters), limit)

    def _filters(self, filters: dict[str, Any] | None) -> dict[str, Any]:
        merged = dict(filters or {})
        merged["layer"] = self.layer
        return merged


class SessionMemoryLayer:
    layer = "session"

    def __init__(self, workspace: str | Path) -> None:
        self.workspace = Path(workspace)
        self.store = SQLiteFTSMemoryStore(self.workspace / ".memory" / "session.sqlite", layer=self.layer)

    def append_event(
        self,
        *,
        session_id: str,
        content: str,
        event_type: str = "event",
        agent_id: str | None = None,
        user_id: str | None = None,
        title: str = "",
        metadata: dict[str, Any] | None = None,
        tags: tuple[str, ...] = (),
    ) -> MemoryRecord:
        metadata = dict(metadata or {})
        metadata["event_type"] = event_type
        record = MemoryRecord.create(
            id=uuid4().hex,
            layer=self.layer,
            namespace="sessions",
            scope=session_id,
            session_id=session_id,
            agent_id=agent_id,
            user_id=user_id,
            title=title or event_type,
            content=content,
            tags=tags,
            metadata=metadata,
            source=f"session:{session_id}",
        )
        return self.store.put(record)

    def put(self, record: MemoryRecord) -> MemoryRecord:
        return self.store.put(record)

    def search_session(self, session_id: str, query: str, limit: int = 10) -> list[MemorySearchResult]:
        return self.store.search(query, {"session_id": session_id}, limit)

    def summarize_session(self, session_id: str, limit: int = 50) -> str:
        records = list(reversed(self.store.list({"session_id": session_id}, limit=limit)))
        if not records:
            return ""
        parts = [f"{record.title}: {record.content}" if record.title else record.content for record in records]
        return "\n".join(parts)

    def search(self, query: str, filters: dict[str, Any] | None = None, limit: int = 10) -> list[MemorySearchResult]:
        return self.store.search(query, filters, limit)

    def get(self, id: str) -> MemoryRecord | None:
        return self.store.get(id)

    def delete(self, id: str) -> bool:
        return self.store.delete(id)

    def list(self, filters: dict[str, Any] | None = None, limit: int = 100) -> list[MemoryRecord]:
        return self.store.list(filters, limit)

    def clear(self, filters: dict[str, Any] | None = None) -> int:
        return self.store.clear(filters)


class SemanticMemoryLayer:
    layer = "semantic"

    def __init__(self, workspace: str | Path) -> None:
        self.workspace = Path(workspace)
        self.markdown = MarkdownMemoryStore(self.workspace, layer=self.layer)
        self.index = SQLiteFTSMemoryStore(self.workspace / ".memory" / "semantic.sqlite", layer=self.layer)

    def upsert_memory(self, record: MemoryRecord) -> MemoryRecord:
        record = record.with_updates(layer=self.layer)
        canonical = self.markdown.put(record)
        return self.index.put(canonical)

    def search_memory(self, query: str, filters: dict[str, Any] | None = None, limit: int = 10) -> list[MemorySearchResult]:
        return self.index.search(query, filters, limit)

    def delete_memory(self, id: str) -> bool:
        removed = self.markdown.delete(id)
        indexed = self.index.delete(id)
        return removed or indexed

    def reindex(self) -> int:
        self.index.clear({"layer": self.layer})
        records = self.markdown.list(limit=100_000)
        for record in records:
            self.index.put(record)
        return len(records)

    def put(self, record: MemoryRecord) -> MemoryRecord:
        return self.upsert_memory(record)

    def search(self, query: str, filters: dict[str, Any] | None = None, limit: int = 10) -> list[MemorySearchResult]:
        return self.search_memory(query, filters, limit)

    def get(self, id: str) -> MemoryRecord | None:
        return self.index.get(id) or self.markdown.get(id)

    def delete(self, id: str) -> bool:
        return self.delete_memory(id)

    def list(self, filters: dict[str, Any] | None = None, limit: int = 100) -> list[MemoryRecord]:
        return self.index.list(filters, limit)

    def clear(self, filters: dict[str, Any] | None = None) -> int:
        records = self.list(filters, limit=100_000)
        for record in records:
            self.delete(record.id)
        return len(records)


class ProceduralMemoryLayer(SemanticMemoryLayer):
    layer = "procedural"

    def __init__(self, workspace: str | Path) -> None:
        self.workspace = Path(workspace)
        self.markdown = MarkdownMemoryStore(self.workspace, layer=self.layer)
        self.index = SQLiteFTSMemoryStore(self.workspace / ".memory" / "procedural.sqlite", layer=self.layer)

    def search_by(
        self,
        *,
        skill_name: str | None = None,
        tool_name: str | None = None,
        capability: str | None = None,
        risk_level: str | None = None,
        query: str = "",
        limit: int = 10,
    ) -> list[MemorySearchResult]:
        filters = {
            "skill_name": skill_name,
            "tool_name": tool_name,
            "capability": capability,
            "risk_level": risk_level,
        }
        return self.search_memory(query, filters, limit)
