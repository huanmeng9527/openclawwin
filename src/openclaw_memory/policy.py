from __future__ import annotations

from dataclasses import dataclass
from typing import Any

from .models import MemoryRecord


MEMORY_READ = "memory.read"
MEMORY_WRITE = "memory.write"
MEMORY_PROCEDURAL_WRITE = "memory.procedural.write"
MEMORY_DELETE = "memory.delete"
MEMORY_REINDEX = "memory.reindex"
POLICY_CHANGE = "policy.change"
SKILL_WRITE = "skill.write"


class MemoryPolicyError(PermissionError):
    pass


@dataclass
class MemoryPolicyGate:
    policy_engine: Any | None = None

    def can_read(self, layer: str, context: dict[str, Any] | None = None) -> bool:
        context = context or {}
        if layer in {"working", "session"}:
            return True
        return MEMORY_READ in set(context.get("permissions") or ())

    def enforce_read(self, layer: str, context: dict[str, Any] | None = None) -> None:
        if self.can_read(layer, context):
            return
        raise MemoryPolicyError(f"{layer} memory read requires: {MEMORY_READ}")

    def enforce_write(self, record: MemoryRecord, context: dict[str, Any] | None = None) -> None:
        context = context or {}
        if record.layer in {"working", "session"}:
            return
        if record.layer == "semantic":
            self._require_any({MEMORY_WRITE}, record, context)
            return
        if record.layer == "procedural":
            self._require_any(
                {MEMORY_PROCEDURAL_WRITE, POLICY_CHANGE, SKILL_WRITE},
                record,
                context,
            )
            return
        raise MemoryPolicyError(f"unknown memory layer: {record.layer}")

    def enforce_delete(self, record: MemoryRecord, context: dict[str, Any] | None = None) -> None:
        self._require_any({MEMORY_DELETE}, record, context or {})

    def enforce_reindex(self, layer: str, context: dict[str, Any] | None = None) -> None:
        if layer in {"working", "session"}:
            return
        self._require_any({MEMORY_REINDEX}, None, context or {}, layer=layer)

    def _require_any(
        self,
        permissions: set[str],
        record: MemoryRecord | None,
        context: dict[str, Any],
        *,
        layer: str | None = None,
    ) -> None:
        granted = set(context.get("permissions") or ())
        if granted.intersection(permissions):
            return
        agent_id = str(context.get("agent_id") or (record.agent_id if record else None) or "default")
        if self.policy_engine is not None:
            tool_policy = getattr(self.policy_engine, "tool_policy", None)
            if tool_policy is not None:
                for permission in permissions:
                    if tool_policy.allowed(permission, agent_id=agent_id):
                        return
        target = record.layer if record is not None else layer
        expected = ", ".join(sorted(permissions))
        raise MemoryPolicyError(f"{target} memory operation requires one of: {expected}")
