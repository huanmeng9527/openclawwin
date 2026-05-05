from __future__ import annotations

from abc import ABC, abstractmethod
from datetime import datetime, timezone
from typing import Any

from .models import MemoryRecord, MemorySearchResult


class MemoryStore(ABC):
    @abstractmethod
    def put(self, record: MemoryRecord) -> MemoryRecord:
        raise NotImplementedError

    @abstractmethod
    def get(self, id: str) -> MemoryRecord | None:
        raise NotImplementedError

    @abstractmethod
    def search(
        self,
        query: str,
        filters: dict[str, Any] | None = None,
        limit: int = 10,
    ) -> list[MemorySearchResult]:
        raise NotImplementedError

    @abstractmethod
    def delete(self, id: str) -> bool:
        raise NotImplementedError

    @abstractmethod
    def list(
        self,
        filters: dict[str, Any] | None = None,
        limit: int = 100,
    ) -> list[MemoryRecord]:
        raise NotImplementedError

    @abstractmethod
    def clear(self, filters: dict[str, Any] | None = None) -> int:
        raise NotImplementedError


class InMemoryMemoryStore(MemoryStore):
    def __init__(self) -> None:
        self._records: dict[str, MemoryRecord] = {}

    def put(self, record: MemoryRecord) -> MemoryRecord:
        self._records[record.id] = record
        return record

    def get(self, id: str) -> MemoryRecord | None:
        record = self._records.get(id)
        if record is not None and expired(record):
            del self._records[id]
            return None
        return record

    def search(
        self,
        query: str,
        filters: dict[str, Any] | None = None,
        limit: int = 10,
    ) -> list[MemorySearchResult]:
        query_text = query.lower().strip()
        records = [record for record in self.list(filters, limit=10_000)]
        results: list[MemorySearchResult] = []
        for record in records:
            haystack = f"{record.title}\n{record.content}\n{' '.join(record.tags)}".lower()
            if query_text and query_text not in haystack:
                continue
            score = 1.0 if not query_text else haystack.count(query_text) + 1.0
            results.append(
                MemorySearchResult(
                    record=record,
                    score=score,
                    source=record.source or "working-memory",
                    reason="working-memory exact match" if query_text else "working-memory recent record",
                )
            )
        results.sort(key=lambda item: (item.score, item.record.updated_at), reverse=True)
        return results[:limit]

    def delete(self, id: str) -> bool:
        return self._records.pop(id, None) is not None

    def list(
        self,
        filters: dict[str, Any] | None = None,
        limit: int = 100,
    ) -> list[MemoryRecord]:
        filters = filters or {}
        records = []
        for record_id, record in list(self._records.items()):
            if expired(record):
                del self._records[record_id]
                continue
            if record_matches(record, filters):
                records.append(record)
        records.sort(key=lambda item: item.updated_at, reverse=True)
        return records[:limit]

    def clear(self, filters: dict[str, Any] | None = None) -> int:
        filters = filters or {}
        ids = [record.id for record in self.list(filters, limit=10_000)]
        for record_id in ids:
            del self._records[record_id]
        return len(ids)


def record_matches(record: MemoryRecord, filters: dict[str, Any]) -> bool:
    for key, expected in filters.items():
        if expected is None:
            continue
        if key == "tags":
            expected_tags = set(expected if isinstance(expected, (list, tuple, set)) else [expected])
            if not expected_tags.issubset(set(record.tags)):
                return False
            continue
        if key in {"skill_name", "tool_name", "capability"}:
            if record.metadata.get(key) != expected:
                return False
            continue
        actual = getattr(record, key, record.metadata.get(key))
        if isinstance(expected, (list, tuple, set)):
            if actual not in expected:
                return False
        elif actual != expected:
            if actual is None:
                continue
            return False
    return True


def expired(record: MemoryRecord) -> bool:
    if not record.expires_at:
        return False
    expires_at = datetime.fromisoformat(record.expires_at)
    if expires_at.tzinfo is None:
        expires_at = expires_at.replace(tzinfo=timezone.utc)
    return expires_at <= datetime.now(timezone.utc)
