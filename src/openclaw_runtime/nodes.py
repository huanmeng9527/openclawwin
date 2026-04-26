from __future__ import annotations

from dataclasses import dataclass, field
from datetime import datetime, timezone
from typing import Any, Callable


NodeHandler = Callable[[dict[str, Any]], Any]


@dataclass
class NodeRecord:
    node_id: str
    role: str
    capabilities: set[str]
    handlers: dict[str, NodeHandler] = field(default_factory=dict)
    connected_at: str = field(default_factory=lambda: datetime.now(timezone.utc).isoformat())


class NodeRegistry:
    def __init__(self) -> None:
        self._nodes: dict[str, NodeRecord] = {}

    def register(
        self,
        node_id: str,
        *,
        role: str = "node",
        capabilities: set[str] | None = None,
        handlers: dict[str, NodeHandler] | None = None,
    ) -> None:
        self._nodes[node_id] = NodeRecord(
            node_id=node_id,
            role=role,
            capabilities=capabilities or set(),
            handlers=handlers or {},
        )

    def call(self, node_id: str, capability: str, params: dict[str, Any] | None = None) -> Any:
        record = self._nodes.get(node_id)
        if record is None:
            raise KeyError(node_id)
        if capability not in record.capabilities:
            raise PermissionError(f"node {node_id} lacks capability {capability}")
        handler = record.handlers.get(capability)
        if handler is None:
            return {"nodeId": node_id, "capability": capability, "params": params or {}}
        return handler(params or {})

    def list_nodes(self) -> list[dict[str, Any]]:
        return [
            {
                "nodeId": record.node_id,
                "role": record.role,
                "capabilities": sorted(record.capabilities),
                "connectedAt": record.connected_at,
            }
            for record in sorted(self._nodes.values(), key=lambda item: item.node_id)
        ]
