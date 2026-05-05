from __future__ import annotations

from pathlib import Path
from typing import Any

from .context_budget import CharacterBudget
from .layers import (
    ProceduralMemoryLayer,
    SemanticMemoryLayer,
    SessionMemoryLayer,
    WorkingMemoryLayer,
)
from .models import MemoryRecord, MemorySearchResult
from .policy import MemoryPolicyGate


class NoOpEmbeddingIndex:
    def index(self, records: list[MemoryRecord]) -> None:
        return None

    def search(self, query: str, limit: int = 10) -> list[MemorySearchResult]:
        return []


class MemoryRouter:
    def __init__(
        self,
        workspace: str | Path,
        *,
        policy_gate: MemoryPolicyGate | None = None,
        embedding_index: NoOpEmbeddingIndex | None = None,
    ) -> None:
        self.workspace = Path(workspace)
        self.policy_gate = policy_gate or MemoryPolicyGate()
        self.embedding_index = embedding_index or NoOpEmbeddingIndex()
        self.working = WorkingMemoryLayer()
        self.session = SessionMemoryLayer(self.workspace)
        self.semantic = SemanticMemoryLayer(self.workspace)
        self.procedural = ProceduralMemoryLayer(self.workspace)
        self.layers = {
            "working": self.working,
            "session": self.session,
            "semantic": self.semantic,
            "procedural": self.procedural,
        }

    def write(
        self,
        record: MemoryRecord,
        requested_layer: str | None = None,
        context: dict[str, Any] | None = None,
    ) -> MemoryRecord:
        layer = requested_layer or record.layer
        record = record.with_updates(layer=layer)
        self.policy_gate.enforce_write(record, context)
        return self.layers[layer].put(record)

    def retrieve(
        self,
        query: str,
        context: dict[str, Any] | None = None,
        layers: list[str] | tuple[str, ...] | None = None,
        limit: int = 10,
        budget_tokens: int | None = None,
    ) -> list[MemorySearchResult]:
        filters = filters_from_context(context or {})
        ordered_layers = list(layers or ("working", "session", "semantic", "procedural"))
        results: list[MemorySearchResult] = []
        for layer_name in ordered_layers:
            if not self.policy_gate.can_read(layer_name, context or {}):
                continue
            layer = self.layers[layer_name]
            layer_filters = dict(filters)
            if layer_name != "working":
                layer_filters.pop("lane_id", None)
            remaining = max(limit - len(results), 0)
            if remaining <= 0:
                break
            for result in layer.search(query, layer_filters, limit=remaining):
                results.append(with_reason(result, layer_name))
        return CharacterBudget(budget_tokens).trim(results[:limit])

    def retrieve_for_prompt(
        self,
        query: str,
        context: dict[str, Any] | None,
        budget_tokens: int,
    ) -> list[MemorySearchResult]:
        return self.retrieve(query, context, budget_tokens=budget_tokens)

    def reindex(self, layer: str | None = None, context: dict[str, Any] | None = None) -> dict[str, int]:
        targets = [layer] if layer else ["semantic", "procedural"]
        counts: dict[str, int] = {}
        for layer_name in targets:
            self.policy_gate.enforce_reindex(layer_name, context)
            target = self.layers[layer_name]
            if hasattr(target, "reindex"):
                counts[layer_name] = target.reindex()
        return counts

    def delete(
        self,
        id: str,
        *,
        layer: str,
        context: dict[str, Any] | None = None,
    ) -> bool:
        target = self.layers[layer]
        record = target.get(id)
        if record is not None:
            self.policy_gate.enforce_delete(record, context)
        return target.delete(id)


def filters_from_context(context: dict[str, Any]) -> dict[str, Any]:
    filters: dict[str, Any] = {}
    for key in ["namespace", "session_id", "agent_id", "user_id", "scope", "lane_id"]:
        if context.get(key) is not None:
            filters[key] = context[key]
    return filters


def with_reason(result: MemorySearchResult, layer_name: str) -> MemorySearchResult:
    return MemorySearchResult(
        record=result.record,
        score=result.score,
        source=result.source,
        reason=f"{layer_name}: {result.reason}",
    )
