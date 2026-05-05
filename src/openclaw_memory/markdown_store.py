from __future__ import annotations

import json
import re
from pathlib import Path
from typing import Any

from .models import MemoryRecord, MemorySearchResult
from .stores import MemoryStore, record_matches


BLOCK_RE = re.compile(
    r"<!-- memory:(?P<id>[A-Za-z0-9_.-]+)\n"
    r"(?P<meta>.*?)\n"
    r"-->\n"
    r"(?P<content>.*?)"
    r"\n<!-- /memory:(?P=id) -->",
    re.DOTALL,
)


SEMANTIC_FILES = {
    "facts": "facts.md",
    "preferences": "preferences.md",
    "project_notes": "project_notes.md",
    "decisions": "decisions.md",
    "known_issues": "known_issues.md",
}

PROCEDURAL_FILES = {
    "skills": "skills.md",
    "tool_recipes": "tool_recipes.md",
    "policies": "policies.md",
    "runbooks": "runbooks.md",
}


class MarkdownMemoryStore(MemoryStore):
    def __init__(self, root: str | Path, *, layer: str) -> None:
        if layer not in {"semantic", "procedural"}:
            raise ValueError("MarkdownMemoryStore only supports semantic/procedural layers")
        self.root = Path(root)
        self.layer = layer
        self.layer_dir = self.root / "memory" / layer
        self.layer_dir.mkdir(parents=True, exist_ok=True)
        self._ensure_files()

    def put(self, record: MemoryRecord) -> MemoryRecord:
        if record.layer != self.layer:
            raise ValueError(f"record layer {record.layer} does not match store layer {self.layer}")
        path = self.path_for(record)
        source = relative_source(self.root, path)
        metadata = dict(record.metadata)
        if record.source and record.source != source:
            metadata.setdefault("provenance", record.source)
        record = record.with_updates(source=source, metadata=metadata)
        text = path.read_text(encoding="utf-8") if path.exists() else self.header_for(path)
        block = format_block(record)
        if get_block(text, record.id) is None:
            text = text.rstrip() + "\n\n" + block + "\n"
        else:
            text = replace_block(text, record.id, block)
        path.write_text(text, encoding="utf-8")
        return record

    def get(self, id: str) -> MemoryRecord | None:
        for record in self.list(limit=100_000):
            if record.id == id:
                return record
        return None

    def search(
        self,
        query: str,
        filters: dict[str, Any] | None = None,
        limit: int = 10,
    ) -> list[MemorySearchResult]:
        query_text = query.lower().strip()
        results = []
        for record in self.list(filters, limit=100_000):
            haystack = f"{record.title}\n{record.content}\n{' '.join(record.tags)}".lower()
            if query_text and query_text not in haystack:
                continue
            results.append(
                MemorySearchResult(
                    record=record,
                    score=1.0 if query_text else 0.0,
                    source=record.source,
                    reason="markdown source match",
                )
            )
        return results[:limit]

    def delete(self, id: str) -> bool:
        for path in self.files():
            text = path.read_text(encoding="utf-8")
            if get_block(text, id) is None:
                continue
            path.write_text(remove_block(text, id).rstrip() + "\n", encoding="utf-8")
            return True
        return False

    def list(
        self,
        filters: dict[str, Any] | None = None,
        limit: int = 100,
    ) -> list[MemoryRecord]:
        filters = filters or {}
        records = []
        for path in self.files():
            for record in parse_blocks(path, self.root):
                if record_matches(record, filters):
                    records.append(record)
        records.sort(key=lambda item: item.updated_at, reverse=True)
        return records[:limit]

    def clear(self, filters: dict[str, Any] | None = None) -> int:
        records = self.list(filters, limit=100_000)
        for record in records:
            self.delete(record.id)
        return len(records)

    def files(self) -> list[Path]:
        return sorted(self.layer_dir.glob("*.md"))

    def path_for(self, record: MemoryRecord) -> Path:
        category = str(record.metadata.get("category") or default_category(record))
        mapping = SEMANTIC_FILES if self.layer == "semantic" else PROCEDURAL_FILES
        return self.layer_dir / mapping.get(category, mapping[next(iter(mapping))])

    def _ensure_files(self) -> None:
        mapping = SEMANTIC_FILES if self.layer == "semantic" else PROCEDURAL_FILES
        for name, filename in mapping.items():
            path = self.layer_dir / filename
            if not path.exists():
                path.write_text(f"# {titleize(name)}\n\n", encoding="utf-8")

    def header_for(self, path: Path) -> str:
        return f"# {titleize(path.stem)}\n\n"


def parse_blocks(path: Path, root: Path) -> list[MemoryRecord]:
    text = path.read_text(encoding="utf-8")
    records = []
    for match in BLOCK_RE.finditer(text):
        metadata = json.loads(match.group("meta"))
        metadata["content"] = match.group("content").strip()
        metadata["source"] = metadata.get("source") or relative_source(root, path)
        records.append(MemoryRecord.from_dict(metadata))
    return records


def format_block(record: MemoryRecord) -> str:
    payload = record.to_dict()
    content = payload.pop("content")
    return (
        f"<!-- memory:{record.id}\n"
        f"{json.dumps(payload, ensure_ascii=False, sort_keys=True)}\n"
        f"-->\n"
        f"{content.rstrip()}\n"
        f"<!-- /memory:{record.id} -->"
    )


def get_block(text: str, id: str) -> re.Match[str] | None:
    for match in BLOCK_RE.finditer(text):
        if match.group("id") == id:
            return match
    return None


def replace_block(text: str, id: str, block: str) -> str:
    match = get_block(text, id)
    if match is None:
        return text.rstrip() + "\n\n" + block + "\n"
    return text[: match.start()] + block + text[match.end() :]


def remove_block(text: str, id: str) -> str:
    match = get_block(text, id)
    if match is None:
        return text
    return text[: match.start()] + text[match.end() :]


def default_category(record: MemoryRecord) -> str:
    for tag in record.tags:
        if record.layer == "semantic" and tag in SEMANTIC_FILES:
            return tag
        if record.layer == "procedural" and tag in PROCEDURAL_FILES:
            return tag
    if record.layer == "procedural":
        return "runbooks"
    return "facts"


def titleize(value: str) -> str:
    return value.replace("_", " ").title()


def relative_source(root: Path, path: Path) -> str:
    try:
        return path.relative_to(root).as_posix()
    except ValueError:
        return path.as_posix()
