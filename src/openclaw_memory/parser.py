from __future__ import annotations

import hashlib
import re
from pathlib import Path

from .models import CANONICAL_KINDS, KIND_PREFIXES, Fact


RETAIN_HEADING_RE = re.compile(r"^\s*#{1,6}\s+retain\s*$", re.IGNORECASE)
ANY_HEADING_RE = re.compile(r"^\s*#{1,6}\s+")
TYPED_BULLET_RE = re.compile(
    r"^\s*[-*]\s+"
    r"(?P<prefix>[WBOS])"
    r"(?:\(c=(?P<confidence>0(?:\.\d+)?|1(?:\.0+)?|\.\d+)\))?"
    r"\s+(?P<body>.+?)\s*$",
    re.IGNORECASE,
)
UNTYPED_BULLET_RE = re.compile(r"^\s*[-*]\s+(?P<body>.+?)\s*$")
ENTITY_RE = re.compile(r"@(?P<entity>[A-Za-z0-9_](?:[A-Za-z0-9_.-]*[A-Za-z0-9_])?)")
REFLECTED_FACT_RE = re.compile(r"<!--\s*fact:(?P<id>[a-f0-9]{16,64})\s*-->")
DATE_FILE_RE = re.compile(r"^\d{4}-\d{2}-\d{2}$")


def parse_workspace_markdown(workspace: Path) -> list[Fact]:
    facts: list[Fact] = []
    for path in iter_canonical_markdown(workspace):
        if is_daily_log(workspace, path):
            facts.extend(parse_daily_log(workspace, path))
        else:
            facts.extend(parse_stable_page(workspace, path))
    return facts


def iter_canonical_markdown(workspace: Path) -> list[Path]:
    candidates: list[Path] = []
    for path in [
        workspace / "memory.md",
        *(workspace / "memory").glob("*.md"),
        *(workspace / "bank").glob("*.md"),
        *(workspace / "bank" / "entities").glob("*.md"),
    ]:
        if path.is_file():
            candidates.append(path)
    return sorted(candidates, key=lambda item: item.as_posix())


def parse_daily_log(workspace: Path, path: Path) -> list[Fact]:
    lines = read_lines(path)
    facts: list[Fact] = []
    in_retain = False
    timestamp = path.stem if DATE_FILE_RE.match(path.stem) else None

    for line_number, line in enumerate(lines, start=1):
        if RETAIN_HEADING_RE.match(line):
            in_retain = True
            continue
        if in_retain and ANY_HEADING_RE.match(line):
            in_retain = False
        if not in_retain:
            continue

        fact = parse_fact_line(
            line=line,
            workspace=workspace,
            path=path,
            line_number=line_number,
            default_kind="observation",
            timestamp=timestamp,
        )
        if fact is not None:
            facts.append(fact)
    return facts


def parse_stable_page(workspace: Path, path: Path) -> list[Fact]:
    lines = read_lines(path)
    facts: list[Fact] = []
    default_kind = infer_kind_from_path(workspace, path)
    for line_number, line in enumerate(lines, start=1):
        fact = parse_fact_line(
            line=line,
            workspace=workspace,
            path=path,
            line_number=line_number,
            default_kind=default_kind,
            timestamp=None,
        )
        if fact is not None:
            facts.append(fact)
    return facts


def parse_fact_line(
    *,
    line: str,
    workspace: Path,
    path: Path,
    line_number: int,
    default_kind: str,
    timestamp: str | None,
) -> Fact | None:
    typed_match = TYPED_BULLET_RE.match(line)
    confidence: float | None = None
    if typed_match:
        prefix = typed_match.group("prefix").upper()
        kind = KIND_PREFIXES[prefix]
        confidence_text = typed_match.group("confidence")
        if confidence_text is not None:
            confidence = float(confidence_text)
        body = typed_match.group("body")
    else:
        untyped_match = UNTYPED_BULLET_RE.match(line)
        if not untyped_match:
            return None
        kind = default_kind if default_kind in CANONICAL_KINDS else "observation"
        body = untyped_match.group("body")

    reflected_id = reflected_fact_id(body)
    content = normalize_fact_content(body)
    if not content:
        return None
    return make_fact(
        workspace=workspace,
        path=path,
        line_number=line_number,
        kind=kind,
        content=content,
        timestamp=timestamp,
        confidence=confidence,
        fact_id=reflected_id,
    )


def make_fact(
    *,
    workspace: Path,
    path: Path,
    line_number: int,
    kind: str,
    content: str,
    timestamp: str | None,
    confidence: float | None,
    fact_id: str | None = None,
) -> Fact:
    source_path = relative_source_path(workspace, path)
    entities = tuple(dict.fromkeys(ENTITY_RE.findall(content)))
    digest = fact_id or hashlib.sha256(
        f"{source_path}:{line_number}:{kind}:{content}".encode("utf-8")
    ).hexdigest()[:16]
    return Fact(
        id=digest,
        kind=kind,
        content=content,
        entities=entities,
        source_path=source_path,
        source_line=line_number,
        timestamp=timestamp,
        confidence=confidence,
    )


def normalize_fact_content(text: str) -> str:
    text = strip_hidden_markers(text)
    return re.sub(r"\s+", " ", text).strip()


def strip_hidden_markers(text: str) -> str:
    text = REFLECTED_FACT_RE.sub("", text)
    return text.strip()


def reflected_fact_id(text: str) -> str | None:
    match = REFLECTED_FACT_RE.search(text)
    return match.group("id") if match else None


def infer_kind_from_path(workspace: Path, path: Path) -> str:
    relative = path.relative_to(workspace).as_posix()
    if relative == "bank/world.md":
        return "world"
    if relative == "bank/experience.md":
        return "experience"
    if relative == "bank/opinions.md":
        return "opinion"
    return "observation"


def is_daily_log(workspace: Path, path: Path) -> bool:
    try:
        relative = path.relative_to(workspace)
    except ValueError:
        return False
    return len(relative.parts) == 2 and relative.parts[0] == "memory"


def relative_source_path(workspace: Path, path: Path) -> str:
    return path.relative_to(workspace).as_posix()


def read_lines(path: Path) -> list[str]:
    return path.read_text(encoding="utf-8").splitlines()


def slugify_entity(entity: str) -> str:
    slug = re.sub(r"[^A-Za-z0-9_.-]+", "-", entity.strip()).strip("-")
    return slug or "Unknown"
