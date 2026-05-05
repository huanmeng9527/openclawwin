from __future__ import annotations

from dataclasses import dataclass, field
from typing import Any, Callable

<<<<<<< HEAD
from openclaw_memory import MemoryRecord, MemoryRouter, WorkspaceMemory
=======
from openclaw_memory import WorkspaceMemory
>>>>>>> 46c87c7efb713265d6ff4ece94e24cde9c5ed8cc


ToolHandler = Callable[[dict[str, Any]], Any]


@dataclass(frozen=True)
class Tool:
    name: str
    description: str
    handler: ToolHandler
    schema: dict[str, Any] = field(default_factory=dict)


@dataclass
class ToolPolicy:
    global_deny: set[str] = field(default_factory=set)
    per_agent_deny: dict[str, set[str]] = field(default_factory=dict)
    global_allow: set[str] = field(default_factory=set)
    per_agent_allow: dict[str, set[str]] = field(default_factory=dict)
    default_allow: bool = False

    def allowed(self, tool_name: str, *, agent_id: str = "default") -> bool:
        if tool_name in self.global_deny:
            return False
        if tool_name in self.per_agent_deny.get(agent_id, set()):
            return False
        if tool_name in self.global_allow:
            return True
        if tool_name in self.per_agent_allow.get(agent_id, set()):
            return True
        return self.default_allow


class ToolRegistry:
    def __init__(self, policy: ToolPolicy | None = None) -> None:
        self.policy = policy or ToolPolicy(default_allow=True)
        self._tools: dict[str, Tool] = {}

    def register(self, tool: Tool) -> None:
        self._tools[tool.name] = tool

    def get(self, name: str) -> Tool:
        if name not in self._tools:
            raise KeyError(name)
        return self._tools[name]

    def list_metadata(self, *, agent_id: str = "default") -> list[dict[str, Any]]:
        metadata = []
        for tool in sorted(self._tools.values(), key=lambda item: item.name):
            if self.policy.allowed(tool.name, agent_id=agent_id):
                metadata.append(
                    {
                        "name": tool.name,
                        "description": tool.description,
                        "schema": tool.schema,
                    }
                )
        return metadata

    def call(self, name: str, args: dict[str, Any] | None = None, *, agent_id: str = "default") -> Any:
        if not self.policy.allowed(name, agent_id=agent_id):
            raise PermissionError(f"tool denied: {name}")
        return self.get(name).handler(args or {})


def register_memory_tools(registry: ToolRegistry, memory: WorkspaceMemory) -> None:
    registry.register(
        Tool(
            name="memory_search",
            description="Search workspace memory with hybrid text recall.",
            schema={"query": "string", "limit": "integer"},
            handler=lambda args: [
                result.to_dict()
                for result in memory.recall(
                    str(args.get("query", "")),
                    limit=int(args.get("limit", 10)),
                )
            ],
        )
    )
    registry.register(
        Tool(
            name="memory_get",
            description="Return memory search result candidates by id or query.",
            schema={"query": "string", "limit": "integer"},
            handler=lambda args: [
                result.to_dict()
                for result in memory.recall(
                    str(args.get("query", "")),
                    limit=int(args.get("limit", 1)),
                )
            ],
        )
    )
<<<<<<< HEAD


def register_memory_router_tools(registry: ToolRegistry, router: MemoryRouter) -> None:
    registry.register(
        Tool(
            name="memory.search",
            description="Search OpenClaw four-layer memory.",
            schema={"query": "string", "layers": "array", "limit": "integer", "context": "object"},
            handler=lambda args: [
                result.to_dict()
                for result in router.retrieve(
                    str(args.get("query", "")),
                    context=dict(args.get("context") or {}),
                    layers=tuple(args["layers"]) if args.get("layers") else None,
                    limit=int(args.get("limit", 10)),
                    budget_tokens=args.get("budget_tokens"),
                )
            ],
        )
    )
    registry.register(
        Tool(
            name="memory.write",
            description="Write a record to working, session, semantic, or procedural memory.",
            schema={"layer": "string", "content": "string", "context": "object"},
            handler=lambda args: router.write(
                record_from_args(args),
                requested_layer=args.get("layer"),
                context=dict(args.get("context") or {}),
            ).to_dict(),
        )
    )
    registry.register(
        Tool(
            name="memory.delete",
            description="Delete a memory record from a specific layer.",
            schema={"id": "string", "layer": "string", "context": "object"},
            handler=lambda args: {
                "deleted": router.delete(
                    str(args["id"]),
                    layer=str(args["layer"]),
                    context=dict(args.get("context") or {}),
                )
            },
        )
    )
    registry.register(
        Tool(
            name="memory.reindex",
            description="Rebuild semantic/procedural SQLite FTS indexes from Markdown truth.",
            schema={"layer": "string", "context": "object"},
            handler=lambda args: router.reindex(
                layer=args.get("layer"),
                context=dict(args.get("context") or {}),
            ),
        )
    )
    registry.register(
        Tool(
            name="memory.summarize_session",
            description="Summarize session episodic memory.",
            schema={"session_id": "string", "limit": "integer"},
            handler=lambda args: {
                "session_id": str(args["session_id"]),
                "summary": router.session.summarize_session(
                    str(args["session_id"]),
                    limit=int(args.get("limit", 50)),
                ),
            },
        )
    )


def record_from_args(args: dict[str, Any]) -> MemoryRecord:
    return MemoryRecord.create(
        id=args.get("id"),
        layer=str(args.get("layer", "working")),
        namespace=str(args.get("namespace", "default")),
        scope=str(args.get("scope", "global")),
        session_id=args.get("session_id"),
        agent_id=args.get("agent_id"),
        user_id=args.get("user_id"),
        key=args.get("key"),
        title=str(args.get("title", "")),
        content=str(args["content"]),
        tags=tuple(args.get("tags") or ()),
        metadata=dict(args.get("metadata") or {}),
        source=str(args.get("source", "tool:memory.write")),
        confidence=float(args.get("confidence", 1.0)),
        expires_at=args.get("expires_at"),
        visibility=str(args.get("visibility", "private")),
        risk_level=str(args.get("risk_level", "low")),
    )
=======
>>>>>>> 46c87c7efb713265d6ff4ece94e24cde9c5ed8cc
