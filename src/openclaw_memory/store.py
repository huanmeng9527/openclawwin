from __future__ import annotations

import json
import os
import re
import sqlite3
from contextlib import closing
from datetime import date, datetime, timedelta, timezone
from pathlib import Path
from typing import Iterable

from .models import KIND_PREFIXES, PREFIX_BY_KIND, Fact, RecallResult
from .parser import parse_workspace_markdown, slugify_entity


DEFAULT_WORKSPACE = Path.home() / ".openclaw" / "workspace"


class WorkspaceMemory:
    def __init__(self, workspace: str | os.PathLike[str] | None = None) -> None:
        self.workspace = Path(
            workspace
            or os.environ.get("OPENCLAW_WORKSPACE")
            or DEFAULT_WORKSPACE
        ).expanduser()

    @property
    def memory_dir(self) -> Path:
        return self.workspace / "memory"

    @property
    def bank_dir(self) -> Path:
        return self.workspace / "bank"

    @property
    def entity_dir(self) -> Path:
        return self.bank_dir / "entities"

    @property
    def derived_dir(self) -> Path:
        return self.workspace / ".memory"

    @property
    def index_path(self) -> Path:
        return self.derived_dir / "index.sqlite"

    def init(self) -> None:
        self.memory_dir.mkdir(parents=True, exist_ok=True)
        self.entity_dir.mkdir(parents=True, exist_ok=True)
        self.derived_dir.mkdir(parents=True, exist_ok=True)
        self._write_if_missing(
            self.workspace / "memory.md",
            "# Core Memory\n\n"
            "Keep this file small. Add durable facts and preferences that should "
            "be visible every session.\n",
        )
        self._write_if_missing(
            self.bank_dir / "world.md",
            "# World Memory\n\nFacts reflected from daily retain logs.\n",
        )
        self._write_if_missing(
            self.bank_dir / "experience.md",
            "# Experience Memory\n\nThings the agent or workspace has done.\n",
        )
        self._write_if_missing(
            self.bank_dir / "opinions.md",
            "# Opinion Memory\n\nPreferences and beliefs with confidence and evidence.\n",
        )

    def retain(
        self,
        content: str,
        *,
        kind: str = "S",
        entities: Iterable[str] = (),
        confidence: float | None = None,
        day: str | date | None = None,
    ) -> Path:
        self.init()
        prefix = normalize_kind_prefix(kind)
        if prefix != "O":
            confidence = None
        target_day = normalize_day(day)
        path = self.memory_dir / f"{target_day}.md"
        if not path.exists():
            path.write_text(
                f"# {target_day}\n\n## Log\n\n## Retain\n",
                encoding="utf-8",
            )

        entity_text = " ".join(f"@{slugify_entity(entity)}" for entity in entities)
        confidence_text = f"(c={confidence:.2f})" if confidence is not None else ""
        fact_line = f"- {prefix}{confidence_text}"
        if entity_text:
            fact_line += f" {entity_text}:"
        fact_line += f" {content.strip()}\n"
        append_to_retain_section(path, fact_line)
        return path

    def rebuild_index(self) -> int:
        self.init()
        facts = parse_workspace_markdown(self.workspace)
        with closing(self.connect()) as connection:
            with connection:
                self._reset_schema(connection)
                self._insert_facts(connection, facts)
        return len(facts)

    def recall(
        self,
        query: str = "",
        *,
        limit: int = 10,
        since_days: int | None = None,
        entity: str | None = None,
        kind: str | None = None,
    ) -> list[RecallResult]:
        if not self.index_path.exists():
            self.rebuild_index()
        with closing(self.connect()) as connection:
            return self._recall_from_index(
                connection,
                query=query,
                limit=limit,
                since_days=since_days,
                entity=entity,
                kind=normalize_kind(kind) if kind else None,
            )

    def reflect(self, *, since_days: int = 7) -> dict[str, int]:
        self.rebuild_index()
        facts = self._recent_daily_facts(since_days)
        counts = {
            "world": self._append_kind_reflections("world", facts, self.bank_dir / "world.md"),
            "experience": self._append_kind_reflections(
                "experience", facts, self.bank_dir / "experience.md"
            ),
            "opinion": self._append_kind_reflections("opinion", facts, self.bank_dir / "opinions.md"),
            "entities": self._append_entity_reflections(facts),
        }
        self.rebuild_index()
        return counts

    def _recent_daily_facts(self, since_days: int) -> list[Fact]:
        cutoff = (date.today() - timedelta(days=since_days)).isoformat()
        facts = []
        for fact in parse_workspace_markdown(self.workspace):
            if not fact.source_path.startswith("memory/"):
                continue
            if fact.timestamp is not None and fact.timestamp < cutoff:
                continue
            facts.append(fact)
        return facts

    def stats(self) -> dict[str, int | str]:
        if not self.index_path.exists():
            self.rebuild_index()
        with closing(self.connect()) as connection:
            facts = connection.execute("SELECT COUNT(*) FROM facts").fetchone()[0]
            entities = connection.execute("SELECT COUNT(DISTINCT entity) FROM fact_entities").fetchone()[0]
            opinions = connection.execute("SELECT COUNT(*) FROM opinions").fetchone()[0]
        return {
            "workspace": str(self.workspace),
            "facts": facts,
            "entities": entities,
            "opinions": opinions,
        }

    def connect(self) -> sqlite3.Connection:
        self.derived_dir.mkdir(parents=True, exist_ok=True)
        connection = sqlite3.connect(self.index_path)
        connection.row_factory = sqlite3.Row
        return connection

    def _reset_schema(self, connection: sqlite3.Connection) -> None:
        connection.executescript(
            """
            DROP TABLE IF EXISTS facts;
            DROP TABLE IF EXISTS fact_entities;
            DROP TABLE IF EXISTS opinions;
            DROP TABLE IF EXISTS embeddings;
            DROP TABLE IF EXISTS metadata;
            DROP TABLE IF EXISTS fact_fts;

            CREATE TABLE facts (
              id TEXT PRIMARY KEY,
              kind TEXT NOT NULL,
              timestamp TEXT,
              content TEXT NOT NULL,
              source_path TEXT NOT NULL,
              source_line INTEGER NOT NULL,
              confidence REAL,
              metadata_json TEXT NOT NULL DEFAULT '{}',
              created_at TEXT NOT NULL
            );

            CREATE TABLE fact_entities (
              fact_id TEXT NOT NULL REFERENCES facts(id) ON DELETE CASCADE,
              entity TEXT NOT NULL,
              PRIMARY KEY (fact_id, entity)
            );

            CREATE TABLE opinions (
              fact_id TEXT PRIMARY KEY REFERENCES facts(id) ON DELETE CASCADE,
              statement TEXT NOT NULL,
              confidence REAL,
              last_updated TEXT NOT NULL,
              evidence_source TEXT NOT NULL
            );

            CREATE TABLE embeddings (
              fact_id TEXT NOT NULL REFERENCES facts(id) ON DELETE CASCADE,
              model TEXT NOT NULL,
              vector BLOB NOT NULL,
              PRIMARY KEY (fact_id, model)
            );

            CREATE TABLE metadata (
              key TEXT PRIMARY KEY,
              value TEXT NOT NULL
            );

            CREATE VIRTUAL TABLE fact_fts USING fts5(
              id UNINDEXED,
              content,
              entities,
              kind,
              tokenize='unicode61'
            );

            CREATE INDEX idx_facts_kind ON facts(kind);
            CREATE INDEX idx_facts_timestamp ON facts(timestamp);
            CREATE INDEX idx_fact_entities_entity ON fact_entities(entity);
            """
        )
        connection.execute(
            "INSERT INTO metadata(key, value) VALUES (?, ?)",
            ("schema_version", "1"),
        )

    def _insert_facts(self, connection: sqlite3.Connection, facts: Iterable[Fact]) -> None:
        now = datetime.now(timezone.utc).isoformat()
        for fact in facts:
            metadata = dict(fact.metadata)
            metadata["entities"] = list(fact.entities)
            metadata_json = json.dumps(metadata, ensure_ascii=False, sort_keys=True)
            connection.execute("DELETE FROM fact_entities WHERE fact_id = ?", (fact.id,))
            connection.execute("DELETE FROM opinions WHERE fact_id = ?", (fact.id,))
            connection.execute("DELETE FROM fact_fts WHERE id = ?", (fact.id,))
            connection.execute(
                """
                INSERT OR REPLACE INTO facts(
                  id, kind, timestamp, content, source_path, source_line,
                  confidence, metadata_json, created_at
                ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
                """,
                (
                    fact.id,
                    fact.kind,
                    fact.timestamp,
                    fact.content,
                    fact.source_path,
                    fact.source_line,
                    fact.confidence,
                    metadata_json,
                    now,
                ),
            )
            for entity in fact.entities:
                connection.execute(
                    "INSERT OR IGNORE INTO fact_entities(fact_id, entity) VALUES (?, ?)",
                    (fact.id, entity),
                )
            if fact.kind == "opinion":
                connection.execute(
                    """
                    INSERT OR REPLACE INTO opinions(
                      fact_id, statement, confidence, last_updated, evidence_source
                    ) VALUES (?, ?, ?, ?, ?)
                    """,
                    (
                        fact.id,
                        fact.content,
                        fact.confidence,
                        now,
                        fact.source,
                    ),
                )
            connection.execute(
                "INSERT INTO fact_fts(id, content, entities, kind) VALUES (?, ?, ?, ?)",
                (fact.id, fact.content, " ".join(fact.entities), fact.kind),
            )

    def _recall_from_index(
        self,
        connection: sqlite3.Connection,
        *,
        query: str,
        limit: int,
        since_days: int | None,
        entity: str | None,
        kind: str | None,
    ) -> list[RecallResult]:
        clauses: list[str] = []
        params: list[object] = []
        joins = ""
        order_by = "ORDER BY COALESCE(f.timestamp, '') DESC, f.source_path, f.source_line"
        score_expression = "NULL AS score"

        fts_query = make_fts_query(query)
        if fts_query:
            joins += " JOIN fact_fts ON fact_fts.id = f.id"
            clauses.append("fact_fts MATCH ?")
            params.append(fts_query)
            score_expression = "bm25(fact_fts) AS score"
            order_by = "ORDER BY score, COALESCE(f.timestamp, '') DESC"

        if since_days is not None:
            cutoff = (date.today() - timedelta(days=since_days)).isoformat()
            clauses.append("(f.timestamp IS NULL OR f.timestamp >= ?)")
            params.append(cutoff)

        if entity:
            joins += " JOIN fact_entities fe ON fe.fact_id = f.id"
            clauses.append("lower(fe.entity) = lower(?)")
            params.append(slugify_entity(entity))

        if kind:
            clauses.append("f.kind = ?")
            params.append(kind)

        where = f"WHERE {' AND '.join(clauses)}" if clauses else ""
        params.append(limit)
        sql = f"""
            SELECT f.*, {score_expression}
            FROM facts f
            {joins}
            {where}
            {order_by}
            LIMIT ?
        """
        try:
            rows = connection.execute(sql, params).fetchall()
        except sqlite3.OperationalError:
            rows = self._fallback_like_recall(
                connection,
                query=query,
                limit=limit,
                since_days=since_days,
                entity=entity,
                kind=kind,
            )
        return [RecallResult(row_to_fact(row), row["score"]) for row in rows]

    def _fallback_like_recall(
        self,
        connection: sqlite3.Connection,
        *,
        query: str,
        limit: int,
        since_days: int | None,
        entity: str | None,
        kind: str | None,
    ) -> list[sqlite3.Row]:
        clauses: list[str] = []
        params: list[object] = []
        joins = ""
        if query.strip():
            clauses.append("lower(f.content) LIKE lower(?)")
            params.append(f"%{query.strip()}%")
        if since_days is not None:
            cutoff = (date.today() - timedelta(days=since_days)).isoformat()
            clauses.append("(f.timestamp IS NULL OR f.timestamp >= ?)")
            params.append(cutoff)
        if entity:
            joins += " JOIN fact_entities fe ON fe.fact_id = f.id"
            clauses.append("lower(fe.entity) = lower(?)")
            params.append(slugify_entity(entity))
        if kind:
            clauses.append("f.kind = ?")
            params.append(kind)
        where = f"WHERE {' AND '.join(clauses)}" if clauses else ""
        params.append(limit)
        return connection.execute(
            f"""
            SELECT f.*, NULL AS score
            FROM facts f
            {joins}
            {where}
            ORDER BY COALESCE(f.timestamp, '') DESC, f.source_path, f.source_line
            LIMIT ?
            """,
            params,
        ).fetchall()

    def _append_kind_reflections(self, kind: str, facts: list[Fact], path: Path) -> int:
        selected = [fact for fact in facts if fact.kind == kind]
        if not selected:
            return 0
        existing = path.read_text(encoding="utf-8") if path.exists() else ""
        new_lines = []
        for fact in selected:
            if fact.id in existing:
                continue
            new_lines.append(format_reflected_fact(fact))
        if not new_lines:
            return 0
        with path.open("a", encoding="utf-8") as file:
            file.write(f"\n## Reflected {date.today().isoformat()}\n\n")
            file.writelines(new_lines)
        return len(new_lines)

    def _append_entity_reflections(self, facts: list[Fact]) -> int:
        count = 0
        by_entity: dict[str, list[Fact]] = {}
        for fact in facts:
            for entity in fact.entities:
                by_entity.setdefault(entity, []).append(fact)

        for entity, entity_facts in sorted(by_entity.items()):
            path = self.entity_dir / f"{slugify_entity(entity)}.md"
            if path.exists():
                existing = path.read_text(encoding="utf-8")
            else:
                existing = f"# {entity}\n\n## Recent Evidence\n\n"
                path.write_text(existing, encoding="utf-8")
            new_lines = []
            for fact in entity_facts:
                if fact.id in existing:
                    continue
                new_lines.append(format_entity_fact(fact))
            if not new_lines:
                continue
            with path.open("a", encoding="utf-8") as file:
                if "## Recent Evidence" not in existing:
                    file.write("\n## Recent Evidence\n\n")
                file.writelines(new_lines)
            count += len(new_lines)
        return count

    @staticmethod
    def _write_if_missing(path: Path, content: str) -> None:
        path.parent.mkdir(parents=True, exist_ok=True)
        if not path.exists():
            path.write_text(content, encoding="utf-8")


def row_to_fact(row: sqlite3.Row) -> Fact:
    metadata = json.loads(row["metadata_json"] or "{}")
    entities = metadata.get("entities")
    if not entities:
        entities = parse_entities_from_content(row["content"])
    return Fact(
        id=row["id"],
        kind=row["kind"],
        content=row["content"],
        entities=tuple(entities),
        source_path=row["source_path"],
        source_line=row["source_line"],
        timestamp=row["timestamp"],
        confidence=row["confidence"],
        metadata=metadata,
    )


def normalize_kind_prefix(kind: str) -> str:
    value = kind.strip()
    if not value:
        return "S"
    if len(value) == 1 and value.upper() in KIND_PREFIXES:
        return value.upper()
    canonical = normalize_kind(value)
    return PREFIX_BY_KIND.get(canonical, "S")


def normalize_kind(kind: str) -> str:
    value = kind.strip().lower()
    if len(value) == 1 and value.upper() in KIND_PREFIXES:
        return KIND_PREFIXES[value.upper()]
    aliases = {
        "bio": "experience",
        "biographical": "experience",
        "belief": "opinion",
        "summary": "observation",
    }
    return aliases.get(value, value)


def normalize_day(day: str | date | None) -> str:
    if day is None:
        return date.today().isoformat()
    if isinstance(day, date):
        return day.isoformat()
    datetime.strptime(day, "%Y-%m-%d")
    return day


def append_to_retain_section(path: Path, fact_line: str) -> None:
    content = path.read_text(encoding="utf-8")
    if re.search(r"^\s*#{1,6}\s+retain\s*$", content, flags=re.IGNORECASE | re.MULTILINE):
        if not content.endswith("\n"):
            content += "\n"
        content += fact_line
    else:
        if not content.endswith("\n"):
            content += "\n"
        content += "\n## Retain\n" + fact_line
    path.write_text(content, encoding="utf-8")


def make_fts_query(query: str) -> str:
    tokens = re.findall(r"[A-Za-z0-9_.@-]+", query)
    if not tokens and query.strip():
        tokens = [query.strip()]
    return " OR ".join(f'"{token.replace(chr(34), chr(34) + chr(34))}"' for token in tokens)


def format_reflected_fact(fact: Fact) -> str:
    confidence = f"(c={fact.confidence:.2f})" if fact.confidence is not None else ""
    entities = " ".join(f"@{entity}" for entity in fact.entities)
    subject = f" {entities}:" if entities else ""
    return (
        f"- {fact.prefix}{confidence}{subject} {fact.content} "
        f"(source: {fact.source}) <!-- fact:{fact.id} -->\n"
    )


def format_entity_fact(fact: Fact) -> str:
    when = fact.timestamp or "undated"
    return (
        f"- {when} {fact.kind}: {fact.content} "
        f"(source: {fact.source}) <!-- fact:{fact.id} -->\n"
    )


def parse_entities_from_content(content: str) -> list[str]:
    return list(
        dict.fromkeys(
            re.findall(r"@([A-Za-z0-9_](?:[A-Za-z0-9_.-]*[A-Za-z0-9_])?)", content)
        )
    )
