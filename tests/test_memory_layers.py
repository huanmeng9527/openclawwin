from __future__ import annotations

import tempfile
import unittest
from pathlib import Path

from openclaw_memory import MemoryRecord, MemoryRouter
from openclaw_memory.layers import SessionMemoryLayer, WorkingMemoryLayer
from openclaw_memory.policy import (
    MEMORY_DELETE,
    MEMORY_PROCEDURAL_WRITE,
    MEMORY_READ,
    MEMORY_REINDEX,
    MEMORY_WRITE,
    MemoryPolicyError,
)


class FourLayerMemoryTests(unittest.TestCase):
    def test_l1_working_memory_is_ephemeral_and_isolated(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            router = MemoryRouter(directory)
            router.working.add(
                "temporary scratchpad about alpha",
                session_id="s1",
                agent_id="a1",
                lane_id="main",
            )
            router.working.add(
                "temporary scratchpad about alpha in another lane",
                session_id="s1",
                agent_id="a1",
                lane_id="side",
            )

            main_results = router.retrieve(
                "alpha",
                {"session_id": "s1", "agent_id": "a1", "lane_id": "main"},
                layers=("working",),
            )
            side_results = router.retrieve(
                "alpha",
                {"session_id": "s1", "agent_id": "a1", "lane_id": "side"},
                layers=("working",),
            )
            fresh_router = MemoryRouter(directory)

            self.assertEqual(len(main_results), 1)
            self.assertEqual(len(side_results), 1)
            self.assertEqual(fresh_router.retrieve("alpha", layers=("working",)), [])

    def test_l2_session_memory_appends_searches_and_summarizes(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            session = SessionMemoryLayer(directory)
            session.append_event(session_id="session-1", event_type="user", content="User asked about alpha.")
            session.append_event(session_id="session-1", event_type="assistant", content="Agent answered alpha details.")
            session.append_event(session_id="session-2", event_type="user", content="Other session alpha.")

            results = session.search_session("session-1", "alpha")
            summary = session.summarize_session("session-1")

            self.assertEqual(len(results), 2)
            self.assertIn("User asked about alpha", summary)
            self.assertIn("Agent answered alpha details", summary)
            self.assertNotIn("Other session", summary)

    def test_l3_semantic_memory_uses_markdown_truth_and_reindex(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            router = MemoryRouter(directory)
            record = MemoryRecord.create(
                id="fact-alpha",
                layer="semantic",
                namespace="project",
                title="Alpha fact",
                content="Alpha Gateway host runs the reference runtime.",
                tags=("facts", "gateway"),
                metadata={"category": "facts"},
                source="test",
                confidence=0.91,
            )

            router.write(record, context={"permissions": {MEMORY_WRITE}})
            markdown = Path(directory) / "memory" / "semantic" / "facts.md"
            router.semantic.index.clear({"layer": "semantic"})
            router.reindex("semantic", context={"permissions": {MEMORY_REINDEX}})
            results = router.retrieve(
                "Gateway host",
                {"namespace": "project", "permissions": {MEMORY_READ}},
                layers=("semantic",),
            )

            self.assertTrue(markdown.exists())
            self.assertIn("fact-alpha", markdown.read_text(encoding="utf-8"))
            self.assertEqual([result.record.id for result in results], ["fact-alpha"])
            self.assertEqual(results[0].record.source, "memory/semantic/facts.md")

    def test_l4_procedural_memory_requires_higher_permission_and_filters(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            router = MemoryRouter(directory)
            record = MemoryRecord.create(
                id="recipe-alpha",
                layer="procedural",
                namespace="ops",
                title="Safe shell recipe",
                content="Run read-only diagnostics before mutating files.",
                tags=("runbooks",),
                metadata={
                    "category": "runbooks",
                    "skill_name": "ops",
                    "tool_name": "shell",
                    "capability": "diagnostics",
                },
                risk_level="medium",
            )

            with self.assertRaises(MemoryPolicyError):
                router.write(record, context={"permissions": {MEMORY_WRITE}})

            router.write(record, context={"permissions": {MEMORY_PROCEDURAL_WRITE}})
            router.reindex("procedural", context={"permissions": {MEMORY_REINDEX}})
            results = router.procedural.search_by(
                tool_name="shell",
                capability="diagnostics",
                risk_level="medium",
                query="diagnostics",
            )

            self.assertEqual(len(results), 1)
            self.assertEqual(results[0].record.id, "recipe-alpha")

    def test_router_cross_layer_retrieval_returns_reason_and_source(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            router = MemoryRouter(directory)
            router.working.add("alpha working note", session_id="s1")
            router.session.append_event(session_id="s1", content="alpha session event")
            router.write(
                MemoryRecord.create(id="sem-alpha", layer="semantic", content="alpha semantic fact"),
                context={"permissions": {MEMORY_WRITE}},
            )
            router.write(
                MemoryRecord.create(
                    id="proc-alpha",
                    layer="procedural",
                    content="alpha procedural playbook",
                    metadata={"category": "runbooks"},
                ),
                context={"permissions": {MEMORY_PROCEDURAL_WRITE}},
            )

            results = router.retrieve(
                "alpha",
                {"permissions": {MEMORY_READ}},
                layers=("working", "session", "semantic", "procedural"),
                limit=10,
            )
            layers = [result.layer for result in results]

            self.assertEqual(layers, ["working", "session", "semantic", "procedural"])
            self.assertTrue(all(result.source for result in results))
            self.assertTrue(all(result.reason.startswith(result.layer) for result in results))

    def test_policy_gate_blocks_unauthorized_l3_and_l4_writes(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            router = MemoryRouter(directory)

            with self.assertRaises(MemoryPolicyError):
                router.write(MemoryRecord.create(layer="semantic", content="blocked semantic"))
            with self.assertRaises(MemoryPolicyError):
                router.write(MemoryRecord.create(layer="procedural", content="blocked procedural"))

    def test_context_budget_keeps_highest_relevance(self) -> None:
        layer = WorkingMemoryLayer()
        layer.add("needle needle high priority memory " + "x" * 100, title="high")
        layer.add("needle low priority memory " + "y" * 100, title="low")
        router = MemoryRouter(tempfile.mkdtemp())
        router.working = layer
        router.layers["working"] = layer

        results = router.retrieve("needle", layers=("working",), limit=2, budget_tokens=180)

        self.assertEqual(len(results), 1)
        self.assertEqual(results[0].record.title, "high")

    def test_delete_removes_memory_from_fts_results(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            router = MemoryRouter(directory)
            record = router.write(
                MemoryRecord.create(id="delete-alpha", layer="semantic", content="delete alpha memory"),
                context={"permissions": {MEMORY_WRITE}},
            )

            self.assertEqual(
                len(router.retrieve("delete alpha", {"permissions": {MEMORY_READ}}, layers=("semantic",))),
                1,
            )
            self.assertTrue(
                router.delete(record.id, layer="semantic", context={"permissions": {MEMORY_DELETE}})
            )
            self.assertEqual(
                router.retrieve("delete alpha", {"permissions": {MEMORY_READ}}, layers=("semantic",)),
                [],
            )

    def test_reindex_is_idempotent(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            router = MemoryRouter(directory)
            router.write(
                MemoryRecord.create(id="idem-alpha", layer="semantic", content="idempotent alpha memory"),
                context={"permissions": {MEMORY_WRITE}},
            )

            first = router.reindex("semantic", context={"permissions": {MEMORY_REINDEX}})
            second = router.reindex("semantic", context={"permissions": {MEMORY_REINDEX}})
            results = router.retrieve(
                "idempotent alpha",
                {"permissions": {MEMORY_READ}},
                layers=("semantic",),
            )

            self.assertEqual(first, {"semantic": 1})
            self.assertEqual(second, {"semantic": 1})
            self.assertEqual([result.record.id for result in results], ["idem-alpha"])


if __name__ == "__main__":
    unittest.main()
