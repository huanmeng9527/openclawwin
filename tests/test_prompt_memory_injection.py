from __future__ import annotations

import tempfile
import unittest
from pathlib import Path

from openclaw_memory import MemoryRecord, MemoryRouter, WorkspaceMemory
from openclaw_memory.policy import MEMORY_PROCEDURAL_WRITE, MEMORY_READ, MEMORY_REINDEX, MEMORY_WRITE
from openclaw_runtime.agent import EchoModelProvider
from openclaw_runtime.prompt import PromptAssembler
from openclaw_runtime.sessions import SessionRecord
from openclaw_runtime.skills import SkillLoader
from openclaw_runtime.tools import ToolPolicy, ToolRegistry


class SpyRouter:
    def __init__(self) -> None:
        self.called = False
        self.context = None

    def retrieve_for_prompt(self, query, context, budget_tokens):
        self.called = True
        self.context = context
        return []


class PromptMemoryInjectionTests(unittest.TestCase):
    def test_prompt_assembler_calls_memory_router_retrieve_for_prompt(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            spy = SpyRouter()
            assembler = make_assembler(directory, spy)
            session = make_session()

            bundle = assembler.assemble(
                session,
                user_text="hello memory",
                memory_context={"permissions": {MEMORY_READ}},
            )

            self.assertTrue(spy.called)
            self.assertEqual(spy.context["session_id"], session.session_id)
            self.assertIn("Current user input", bundle.system)

    def test_prompt_contains_l1_l2_l3_l4_memory_results(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            router = seeded_router(directory)
            assembler = make_assembler(directory, router)
            session = make_session()

            bundle = assembler.assemble(
                session,
                user_text="alpha",
                memory_context={"permissions": {MEMORY_READ}},
            )

            system = bundle.system
            self.assertIn("[Memory Context]", system)
            self.assertIn("L1 Working", system)
            self.assertIn("alpha working", system)
            self.assertIn("L2 Session", system)
            self.assertIn("alpha session", system)
            self.assertIn("L3 Semantic", system)
            self.assertIn("alpha semantic", system)
            self.assertIn("L4 Procedural", system)
            self.assertIn("alpha procedural", system)
            self.assertIn("reason:", system)

    def test_prompt_memory_budget_trims_long_results(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            router = MemoryRouter(directory)
            session = make_session()
            router.working.add("alpha alpha compact", session_id=session.session_id, title="compact")
            router.working.add("alpha long " + "x" * 600, session_id=session.session_id, title="long")
            assembler = make_assembler(directory, router, memory_budget_chars=120)

            bundle = assembler.assemble(session, user_text="alpha")

            self.assertIn("compact", bundle.system)
            self.assertNotIn("long", bundle.system)

    def test_without_memory_read_prompt_omits_l3_and_l4(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            router = seeded_router(directory)
            assembler = make_assembler(directory, router)
            session = make_session()

            bundle = assembler.assemble(session, user_text="alpha")

            self.assertIn("alpha working", bundle.system)
            self.assertIn("alpha session", bundle.system)
            self.assertNotIn("alpha semantic", bundle.system)
            self.assertNotIn("alpha procedural", bundle.system)

    def test_legacy_workspace_memory_recall_fallback_still_works(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            memory = WorkspaceMemory(directory)
            memory.retain("Legacy alpha memory remains searchable.", kind="S", day="2026-04-30")
            memory.rebuild_index()
            assembler = PromptAssembler(
                directory,
                memory=memory,
                tool_registry=ToolRegistry(ToolPolicy(default_allow=True)),
                skill_loader=SkillLoader(directory),
            )
            session = make_session()

            bundle = assembler.assemble(session, user_text="Legacy alpha")

            self.assertIn("Legacy Recall", bundle.system)
            self.assertIn("Legacy alpha memory", bundle.system)

    def test_echo_model_provider_runtime_smoke(self) -> None:
        model = EchoModelProvider()
        output = model.generate(system="[Memory Context]", user_text="hello", session=make_session())

        self.assertEqual(output.text, "Echo: hello")


def seeded_router(directory: str) -> MemoryRouter:
    router = MemoryRouter(directory)
    session = make_session()
    router.working.add("alpha working note", session_id=session.session_id, title="working")
    router.session.append_event(session_id=session.session_id, content="alpha session event", title="session")
    router.write(
        MemoryRecord.create(
            id="prompt-semantic",
            layer="semantic",
            content="alpha semantic fact",
            title="semantic",
            metadata={"category": "facts"},
        ),
        context={"permissions": {MEMORY_WRITE}},
    )
    router.write(
        MemoryRecord.create(
            id="prompt-procedural",
            layer="procedural",
            content="alpha procedural playbook",
            title="procedural",
            metadata={"category": "runbooks", "tool_name": "shell"},
        ),
        context={"permissions": {MEMORY_PROCEDURAL_WRITE}},
    )
    router.reindex("semantic", context={"permissions": {MEMORY_REINDEX}})
    router.reindex("procedural", context={"permissions": {MEMORY_REINDEX}})
    return router


def make_assembler(directory: str, router, memory_budget_chars: int = 4_000) -> PromptAssembler:
    return PromptAssembler(
        Path(directory),
        memory=WorkspaceMemory(directory),
        memory_router=router,
        tool_registry=ToolRegistry(ToolPolicy(default_allow=True)),
        skill_loader=SkillLoader(directory),
        memory_budget_chars=memory_budget_chars,
    )


def make_session() -> SessionRecord:
    return SessionRecord(
        session_key="agent:default:telegram:dm:alice",
        session_id="session-alpha",
        agent_id="default",
        private=True,
        channel="telegram",
        peer_id="alice",
    )


if __name__ == "__main__":
    unittest.main()
