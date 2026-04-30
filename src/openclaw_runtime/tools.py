from __future__ import annotations

from dataclasses import dataclass, field
from typing import Any, Callable

from openclaw_memory import WorkspaceMemory


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
