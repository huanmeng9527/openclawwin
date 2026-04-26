from __future__ import annotations

import tempfile
import unittest
from pathlib import Path

from openclaw_memory import WorkspaceMemory


class WorkspaceMemoryTests(unittest.TestCase):
    def test_init_creates_four_layer_layout(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            memory = WorkspaceMemory(directory)

            memory.init()

            workspace = Path(directory)
            self.assertTrue((workspace / "memory.md").is_file())
            self.assertTrue((workspace / "memory").is_dir())
            self.assertTrue((workspace / "bank" / "world.md").is_file())
            self.assertTrue((workspace / "bank" / "experience.md").is_file())
            self.assertTrue((workspace / "bank" / "opinions.md").is_file())
            self.assertTrue((workspace / "bank" / "entities").is_dir())
            self.assertTrue((workspace / ".memory").is_dir())

    def test_retain_index_and_recall_typed_fact(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            memory = WorkspaceMemory(directory)
            memory.retain(
                "I fixed the Baileys WS crash by wrapping connection.update handlers.",
                kind="B",
                entities=["warelay"],
                day="2026-04-25",
            )

            indexed = memory.rebuild_index()
            results = memory.recall("Baileys crash", limit=3)

            self.assertGreaterEqual(indexed, 1)
            self.assertEqual(len(results), 1)
            fact = results[0].fact
            self.assertEqual(fact.kind, "experience")
            self.assertEqual(fact.entities, ("warelay",))
            self.assertEqual(fact.timestamp, "2026-04-25")
            self.assertIn("memory/2026-04-25.md#L", fact.source)

    def test_reflect_updates_bank_and_entity_pages_once(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            memory = WorkspaceMemory(directory)
            memory.retain(
                "Prefers concise replies on WhatsApp.",
                kind="O",
                entities=["Peter"],
                confidence=0.95,
                day="2026-04-25",
            )

            first_counts = memory.reflect(since_days=1)
            second_counts = memory.reflect(since_days=1)

            workspace = Path(directory)
            opinions = (workspace / "bank" / "opinions.md").read_text(encoding="utf-8")
            entity_page = (workspace / "bank" / "entities" / "Peter.md").read_text(encoding="utf-8")
            self.assertEqual(first_counts["opinion"], 1)
            self.assertEqual(first_counts["entities"], 1)
            self.assertEqual(second_counts["opinion"], 0)
            self.assertIn("Prefers concise replies", opinions)
            self.assertIn("c=0.95", opinions)
            self.assertIn("Prefers concise replies", entity_page)


if __name__ == "__main__":
    unittest.main()
