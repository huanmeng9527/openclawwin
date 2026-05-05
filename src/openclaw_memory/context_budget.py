from __future__ import annotations

from .models import MemorySearchResult


class CharacterBudget:
    def __init__(self, budget: int | None) -> None:
        self.budget = budget

    def trim(self, results: list[MemorySearchResult]) -> list[MemorySearchResult]:
        if self.budget is None or self.budget <= 0:
            return results
        kept: list[MemorySearchResult] = []
        used = 0
        for result in results:
            cost = estimate_cost(result)
            if kept and used + cost > self.budget:
                continue
            if not kept and cost > self.budget:
                kept.append(result)
                break
            kept.append(result)
            used += cost
        return kept


def estimate_cost(result: MemorySearchResult) -> int:
    record = result.record
    return len(record.title) + len(record.content) + len(record.source) + 32
