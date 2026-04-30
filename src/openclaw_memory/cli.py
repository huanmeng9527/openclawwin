from __future__ import annotations

import argparse
import json
from typing import Sequence

from .store import WorkspaceMemory


def main(argv: Sequence[str] | None = None) -> int:
    parser = build_parser()
    args = list(argv) if argv is not None else None
    if args and args[:1] == ["memory"]:
        args = args[1:]
    namespace = parser.parse_args(args)
    if not hasattr(namespace, "handler"):
        parser.print_help()
        return 2
    return namespace.handler(namespace)


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(
        prog="openclaw-memory",
        description="OpenClaw four-layer workspace memory.",
    )
    add_workspace_argument(parser)
    subparsers = parser.add_subparsers(dest="command")

    init_parser = subparsers.add_parser("init", help="Create memory workspace layout.")
    add_workspace_argument(init_parser)
    init_parser.set_defaults(handler=handle_init)

    retain_parser = subparsers.add_parser("retain", help="Append a typed fact to a daily log.")
    add_workspace_argument(retain_parser)
    retain_parser.add_argument("content")
    retain_parser.add_argument("--kind", default="S", choices=["W", "B", "O", "S", "world", "experience", "opinion", "observation"])
    retain_parser.add_argument("--entity", action="append", default=[], help="Entity slug, repeatable.")
    retain_parser.add_argument("--confidence", type=float, help="Opinion confidence from 0.0 to 1.0.")
    retain_parser.add_argument("--date", help="Daily log date in YYYY-MM-DD.")
    retain_parser.set_defaults(handler=handle_retain)

    index_parser = subparsers.add_parser("index", help="Rebuild the derived SQLite index.")
    add_workspace_argument(index_parser)
    index_parser.set_defaults(handler=handle_index)

    recall_parser = subparsers.add_parser("recall", help="Search memory facts.")
    add_workspace_argument(recall_parser)
    recall_parser.add_argument("query", nargs="?", default="")
    recall_parser.add_argument("--k", "--limit", dest="limit", type=int, default=10)
    recall_parser.add_argument("--since", help="Window like 7d or 30d.")
    recall_parser.add_argument("--entity", help="Filter by entity.")
    recall_parser.add_argument("--kind", choices=["W", "B", "O", "S", "world", "experience", "opinion", "observation"])
    recall_parser.add_argument("--json", action="store_true", help="Emit JSON.")
    recall_parser.set_defaults(handler=handle_recall)

    reflect_parser = subparsers.add_parser("reflect", help="Update bank pages from recent facts.")
    add_workspace_argument(reflect_parser)
    reflect_parser.add_argument("--since", default="7d", help="Window like 7d or 30d.")
    reflect_parser.set_defaults(handler=handle_reflect)

    stats_parser = subparsers.add_parser("stats", help="Show index stats.")
    add_workspace_argument(stats_parser)
    stats_parser.set_defaults(handler=handle_stats)

    return parser


def add_workspace_argument(parser: argparse.ArgumentParser) -> None:
    parser.add_argument(
        "--workspace",
        help="Workspace path. Defaults to OPENCLAW_WORKSPACE or ~/.openclaw/workspace.",
    )


def handle_init(args: argparse.Namespace) -> int:
    memory = WorkspaceMemory(args.workspace)
    memory.init()
    print(f"Initialized {memory.workspace}")
    return 0


def handle_retain(args: argparse.Namespace) -> int:
    if args.confidence is not None and not 0.0 <= args.confidence <= 1.0:
        raise SystemExit("--confidence must be between 0.0 and 1.0")
    memory = WorkspaceMemory(args.workspace)
    path = memory.retain(
        args.content,
        kind=args.kind,
        entities=args.entity,
        confidence=args.confidence,
        day=args.date,
    )
    print(f"Retained fact in {path}")
    return 0


def handle_index(args: argparse.Namespace) -> int:
    memory = WorkspaceMemory(args.workspace)
    count = memory.rebuild_index()
    print(f"Indexed {count} facts into {memory.index_path}")
    return 0


def handle_recall(args: argparse.Namespace) -> int:
    memory = WorkspaceMemory(args.workspace)
    results = memory.recall(
        args.query,
        limit=args.limit,
        since_days=parse_since(args.since),
        entity=args.entity,
        kind=args.kind,
    )
    if args.json:
        print(json.dumps([result.to_dict() for result in results], ensure_ascii=False, indent=2))
        return 0
    for result in results:
        fact = result.fact
        confidence = f" c={fact.confidence:.2f}" if fact.confidence is not None else ""
        entities = f" entities={','.join(fact.entities)}" if fact.entities else ""
        timestamp = f" timestamp={fact.timestamp}" if fact.timestamp else ""
        print(f"[{fact.kind}{confidence}{timestamp}{entities}] {fact.content}")
        print(f"  source: {fact.source}")
    return 0


def handle_reflect(args: argparse.Namespace) -> int:
    memory = WorkspaceMemory(args.workspace)
    counts = memory.reflect(since_days=parse_since(args.since) or 7)
    print(json.dumps(counts, ensure_ascii=False, indent=2))
    return 0


def handle_stats(args: argparse.Namespace) -> int:
    memory = WorkspaceMemory(args.workspace)
    print(json.dumps(memory.stats(), ensure_ascii=False, indent=2))
    return 0


def parse_since(value: str | None) -> int | None:
    if value is None:
        return None
    text = value.strip().lower()
    if not text:
        return None
    if text.endswith("d"):
        return int(text[:-1])
    return int(text)
