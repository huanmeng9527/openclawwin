from __future__ import annotations

import json
import sqlite3
from contextlib import closing
from pathlib import Path
from typing import Any

from .models import MemoryRecord, MemorySearchResult
from .stores import MemoryStore, record_matches


class SQLiteFTSMemoryStore(MemoryStore):
    def __init__(self, path: str | Path, *, layer: str | None = None) -> None:
        self.path = Path(path)
        self.layer = layer
        self.path.parent.mkdir(parents=True, exist_ok=True)
        with closing(self.connect()) as connection:
            self.ensure_schema(connection)

    def connect(self) -> sqlite3.Connection:
        connection = sqlite3.connect(self.path)
        connection.row_factory = sqlite3.Row
        return connection

    def put(self, record: MemoryRecord) -> MemoryRecord:
        with closing(self.connect()) as connection:
            with connection:
                self.ensure_schema(connection)
                connection.execute("DELETE FROM memory_fts WHERE id = ?", (record.id,))
                connection.execute(
                    """
                    INSERT OR REPLACE INTO memory_records(
                      id, layer, namespace, scope, session_id, agent_id, user_id,
                      key, title, content, tags_json, metadata_json, source,
                      confidence, created_at, updated_at, expires_at, visibility,
                      risk_level
                    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
                    """,
                    record_to_row(record),
                )
                connection.execute(
                    """
                    INSERT INTO memory_fts(id, layer, namespace, title, content, tags, metadata)
                    VALUES (?, ?, ?, ?, ?, ?, ?)
                    """,
                    (
                        record.id,
                        record.layer,
                        record.namespace,
                        record.title,
                        record.content,
                        " ".join(record.tags),
                        json.dumps(record.metadata, ensure_ascii=False, sort_keys=True),
                    ),
                )
        return record

    def get(self, id: str) -> MemoryRecord | None:
        with closing(self.connect()) as connection:
            row = connection.execute(
                "SELECT * FROM memory_records WHERE id = ?",
                (id,),
            ).fetchone()
        return row_to_record(row) if row is not None else None

    def search(
        self,
        query: str,
        filters: dict[str, Any] | None = None,
        limit: int = 10,
    ) -> list[MemorySearchResult]:
        filters = self._with_layer_filter(filters)
        query_text = query.strip()
        with closing(self.connect()) as connection:
            if query_text:
                rows = self._search_fts(connection, query_text, filters, limit)
            else:
                rows = self._list_rows(connection, filters, limit)
        results = []
        for row in rows:
            record = row_to_record(row)
            if not record_matches(record, filters):
                continue
            score = float(row["score"]) if "score" in row.keys() and row["score"] is not None else 0.0
            results.append(
                MemorySearchResult(
                    record=record,
                    score=score,
                    source=record.source or f"sqlite:{self.path.name}",
                    reason="sqlite-fts bm25" if query_text else "sqlite list",
                )
            )
        return results[:limit]

    def delete(self, id: str) -> bool:
        with closing(self.connect()) as connection:
            with connection:
                exists = connection.execute(
                    "SELECT 1 FROM memory_records WHERE id = ?",
                    (id,),
                ).fetchone()
                connection.execute("DELETE FROM memory_records WHERE id = ?", (id,))
                connection.execute("DELETE FROM memory_fts WHERE id = ?", (id,))
        return exists is not None

    def list(
        self,
        filters: dict[str, Any] | None = None,
        limit: int = 100,
    ) -> list[MemoryRecord]:
        filters = self._with_layer_filter(filters)
        with closing(self.connect()) as connection:
            rows = self._list_rows(connection, filters, limit)
        return [row_to_record(row) for row in rows]

    def clear(self, filters: dict[str, Any] | None = None) -> int:
        records = self.list(filters, limit=100_000)
        for record in records:
            self.delete(record.id)
        return len(records)

    def ensure_schema(self, connection: sqlite3.Connection) -> None:
        connection.executescript(
            """
            CREATE TABLE IF NOT EXISTS memory_records (
              id TEXT PRIMARY KEY,
              layer TEXT NOT NULL,
              namespace TEXT NOT NULL,
              scope TEXT NOT NULL,
              session_id TEXT,
              agent_id TEXT,
              user_id TEXT,
              key TEXT,
              title TEXT NOT NULL,
              content TEXT NOT NULL,
              tags_json TEXT NOT NULL,
              metadata_json TEXT NOT NULL,
              source TEXT NOT NULL,
              confidence REAL NOT NULL,
              created_at TEXT NOT NULL,
              updated_at TEXT NOT NULL,
              expires_at TEXT,
              visibility TEXT NOT NULL,
              risk_level TEXT NOT NULL
            );

            CREATE VIRTUAL TABLE IF NOT EXISTS memory_fts USING fts5(
              id UNINDEXED,
              layer UNINDEXED,
              namespace UNINDEXED,
              title,
              content,
              tags,
              metadata,
              tokenize='unicode61'
            );

            CREATE INDEX IF NOT EXISTS idx_memory_layer ON memory_records(layer);
            CREATE INDEX IF NOT EXISTS idx_memory_namespace ON memory_records(namespace);
            CREATE INDEX IF NOT EXISTS idx_memory_session ON memory_records(session_id);
            CREATE INDEX IF NOT EXISTS idx_memory_agent ON memory_records(agent_id);
            """
        )

    def _search_fts(
        self,
        connection: sqlite3.Connection,
        query: str,
        filters: dict[str, Any],
        limit: int,
    ) -> list[sqlite3.Row]:
        clauses, params = build_where(filters, alias="r")
        where = f"WHERE memory_fts MATCH ?"
        params = [make_fts_query(query), *params]
        if clauses:
            where += " AND " + " AND ".join(clauses)
        try:
            return connection.execute(
                f"""
                SELECT r.*, -bm25(memory_fts) AS score
                FROM memory_records r
                JOIN memory_fts ON memory_fts.id = r.id
                {where}
                ORDER BY bm25(memory_fts), r.updated_at DESC
                LIMIT ?
                """,
                [*params, limit],
            ).fetchall()
        except sqlite3.OperationalError:
            return [
                row
                for row in self._list_rows(connection, filters, limit=100_000)
                if query.lower() in f"{row['title']} {row['content']} {row['tags_json']}".lower()
            ][:limit]

    def _list_rows(
        self,
        connection: sqlite3.Connection,
        filters: dict[str, Any],
        limit: int,
    ) -> list[sqlite3.Row]:
        clauses, params = build_where(filters, alias="memory_records")
        where = f"WHERE {' AND '.join(clauses)}" if clauses else ""
        rows = connection.execute(
            f"""
            SELECT *, 0.0 AS score
            FROM memory_records
            {where}
            ORDER BY updated_at DESC
            LIMIT ?
            """,
            [*params, limit],
        ).fetchall()
        return [row for row in rows if record_matches(row_to_record(row), filters)]

    def _with_layer_filter(self, filters: dict[str, Any] | None) -> dict[str, Any]:
        merged = dict(filters or {})
        if self.layer is not None:
            merged["layer"] = self.layer
        return merged


def record_to_row(record: MemoryRecord) -> tuple[Any, ...]:
    return (
        record.id,
        record.layer,
        record.namespace,
        record.scope,
        record.session_id,
        record.agent_id,
        record.user_id,
        record.key,
        record.title,
        record.content,
        json.dumps(list(record.tags), ensure_ascii=False),
        json.dumps(record.metadata, ensure_ascii=False, sort_keys=True),
        record.source,
        record.confidence,
        record.created_at,
        record.updated_at,
        record.expires_at,
        record.visibility,
        record.risk_level,
    )


def row_to_record(row: sqlite3.Row) -> MemoryRecord:
    return MemoryRecord(
        id=row["id"],
        layer=row["layer"],
        namespace=row["namespace"],
        scope=row["scope"],
        session_id=row["session_id"],
        agent_id=row["agent_id"],
        user_id=row["user_id"],
        key=row["key"],
        title=row["title"],
        content=row["content"],
        tags=tuple(json.loads(row["tags_json"] or "[]")),
        metadata=json.loads(row["metadata_json"] or "{}"),
        source=row["source"],
        confidence=float(row["confidence"]),
        created_at=row["created_at"],
        updated_at=row["updated_at"],
        expires_at=row["expires_at"],
        visibility=row["visibility"],
        risk_level=row["risk_level"],
    )


def build_where(filters: dict[str, Any], *, alias: str) -> tuple[list[str], list[Any]]:
    clauses: list[str] = []
    params: list[Any] = []
    column_names = {
        "layer",
        "namespace",
        "scope",
        "session_id",
        "agent_id",
        "user_id",
        "key",
        "visibility",
        "risk_level",
    }
    nullable_scope_columns = {"session_id", "agent_id", "user_id"}
    for key, expected in filters.items():
        if expected is None or key == "tags":
            continue
        if key in column_names:
            if isinstance(expected, (list, tuple, set)):
                placeholders = ", ".join("?" for _ in expected)
                if key in nullable_scope_columns:
                    clauses.append(f"({alias}.{key} IN ({placeholders}) OR {alias}.{key} IS NULL)")
                else:
                    clauses.append(f"{alias}.{key} IN ({placeholders})")
                params.extend(list(expected))
            else:
                if key in nullable_scope_columns:
                    clauses.append(f"({alias}.{key} = ? OR {alias}.{key} IS NULL)")
                else:
                    clauses.append(f"{alias}.{key} = ?")
                params.append(expected)
    return clauses, params


def make_fts_query(query: str) -> str:
    tokens = [token.replace('"', '""') for token in query.split() if token.strip()]
    if not tokens:
        return '""'
    return " OR ".join(f'"{token}"' for token in tokens)
