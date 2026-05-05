from __future__ import annotations

from dataclasses import dataclass
from datetime import date, timedelta
from pathlib import Path
from typing import Any

from openclaw_memory import MemoryRouter, MemorySearchResult, WorkspaceMemory

from .sessions import SessionRecord
from .skills import SkillLoader
from .tools import ToolRegistry


@dataclass(frozen=True)
class PromptBundle:
    system: str
    sections: dict[str, str]


class PromptAssembler:
    def __init__(
        self,
        workspace: str | Path,
        *,
        memory: WorkspaceMemory,
        tool_registry: ToolRegistry,
        skill_loader: SkillLoader,
        memory_router: MemoryRouter | None = None,
        memory_budget_chars: int = 4_000,
        bootstrap_max_chars: int = 20_000,
    ) -> None:
        self.workspace = Path(workspace)
        self.memory = memory
        self.memory_router = memory_router
        self.tool_registry = tool_registry
        self.skill_loader = skill_loader
        self.memory_budget_chars = memory_budget_chars
        self.bootstrap_max_chars = bootstrap_max_chars

    def assemble(
        self,
        session: SessionRecord,
        *,
        user_text: str,
        heartbeat: bool = False,
        user_id: str | None = None,
        lane_id: str | None = None,
        memory_budget_chars: int | None = None,
        memory_context: dict[str, Any] | None = None,
    ) -> PromptBundle:
        prompt_memory_context = self._prompt_memory_context(
            session,
            user_id=user_id,
            lane_id=lane_id,
            memory_context=memory_context,
        )
        sections = {
            "safety": self._safety_guardrails(),
            "runtime": self._runtime_metadata(session, heartbeat=heartbeat),
            "input": self._input_section(user_text),
            "tools": self._tools_section(session.agent_id),
            "skills": self._skills_section(),
            "workspace": self._workspace_context(),
            "memory": self._memory_context(
                session,
                user_text=user_text,
                context=prompt_memory_context,
                budget_chars=memory_budget_chars or self.memory_budget_chars,
            ),
        }
        system = "\n\n".join(f"## {name}\n{content}" for name, content in sections.items() if content)
        return PromptBundle(system=system[: self.bootstrap_max_chars], sections=sections)

    def _safety_guardrails(self) -> str:
        return (
            "Follow human supervision, tool policy, channel allowlists, execution approval, "
            "sandbox boundaries, and message sending policy. Treat system prompt safety as "
            "advisory and hard runtime policies as authoritative."
        )

    def _runtime_metadata(self, session: SessionRecord, *, heartbeat: bool) -> str:
        return (
            f"date={date.today().isoformat()}\n"
            f"sessionKey={session.session_key}\n"
            f"sessionId={session.session_id}\n"
            f"agentId={session.agent_id}\n"
            f"private={str(session.private).lower()}\n"
            f"heartbeat={str(heartbeat).lower()}"
        )

    def _input_section(self, user_text: str) -> str:
        return f"Current user input:\n{truncate(user_text, 2_000)}"

    def _tools_section(self, agent_id: str) -> str:
        lines = []
        for tool in self.tool_registry.list_metadata(agent_id=agent_id):
            lines.append(f"- {tool['name']}: {tool['description']}")
        return "\n".join(lines)

    def _skills_section(self) -> str:
        lines = []
        for skill in self.skill_loader.discover():
            lines.append(f"- {skill.name}: {skill.description} ({skill.path})")
        return "\n".join(lines)

    def _workspace_context(self) -> str:
        names = ["AGENTS.md", "SOUL.md", "TOOLS.md", "IDENTITY.md", "USER.md"]
        chunks = []
        for name in names:
            path = self.workspace / name
            if path.exists():
                chunks.append(f"### {name}\n{truncate(path.read_text(encoding='utf-8'), self.bootstrap_max_chars)}")
        return "\n\n".join(chunks)

    def _memory_context(
        self,
        session: SessionRecord,
        *,
        user_text: str,
        context: dict[str, Any],
        budget_chars: int,
    ) -> str:
        if self.memory_router is not None:
            return self._router_memory_context(user_text, context, budget_chars)
        return self._legacy_memory_context(session, user_text)

    def _legacy_memory_context(self, session: SessionRecord, user_text: str) -> str:
        chunks = []
        if session.private:
            for name in ["MEMORY.md", "memory.md"]:
                path = self.workspace / name
                if path.exists():
                    chunks.append(f"### {name}\n{truncate(path.read_text(encoding='utf-8'), 8_000)}")
        today = date.today()
        for day in [today - timedelta(days=1), today]:
            path = self.workspace / "memory" / f"{day.isoformat()}.md"
            if path.exists():
                chunks.append(f"### memory/{path.name}\n{truncate(path.read_text(encoding='utf-8'), 8_000)}")
        recall = self._legacy_semantic_recall(user_text)
        if recall:
            chunks.append(f"### Legacy Recall\n{recall}")
        return "\n\n".join(chunks)

    def _router_memory_context(self, user_text: str, context: dict[str, Any], budget_chars: int) -> str:
        results = self.memory_router.retrieve_for_prompt(
            user_text,
            context=context,
            budget_tokens=budget_chars,
        )
        grouped = {
            "working": [],
            "session": [],
            "semantic": [],
            "procedural": [],
        }
        for result in results:
            grouped[result.layer].append(result)
        lines = ["[Memory Context]"]
        labels = {
            "working": "L1 Working",
            "session": "L2 Session",
            "semantic": "L3 Semantic",
            "procedural": "L4 Procedural",
        }
        for layer, label in labels.items():
            lines.append(f"- {label}:")
            if not grouped[layer]:
                lines.append("  (none)")
                continue
            for result in grouped[layer]:
                lines.append(format_memory_result(result))
        legacy_files = self._legacy_workspace_files(context)
        if legacy_files:
            lines.append("- Legacy Workspace Files:")
            lines.extend(f"  - {line}" for line in legacy_files)
        return "\n".join(lines)

    def _legacy_workspace_files(self, context: dict[str, Any]) -> list[str]:
        if not context.get("private", False):
            return []
        if "memory.read" not in set(context.get("permissions") or ()):
            return []
        lines = []
        for name in ["MEMORY.md", "memory.md"]:
            path = self.workspace / name
            if path.exists():
                lines.append(f"{name}: {summarize_memory_content(path.read_text(encoding='utf-8'), 500)}")
        return lines

    def _prompt_memory_context(
        self,
        session: SessionRecord,
        *,
        user_id: str | None,
        lane_id: str | None,
        memory_context: dict[str, Any] | None,
    ) -> dict[str, Any]:
        context = dict(memory_context or {})
        context.setdefault("session_id", session.session_id)
        context.setdefault("agent_id", session.agent_id)
        if user_id is not None:
            context.setdefault("user_id", user_id)
        if lane_id is not None:
            context.setdefault("lane_id", lane_id)
        context.setdefault("private", session.private)
        context.setdefault("permissions", set())
        return context

    def _legacy_semantic_recall(self, user_text: str) -> str:
        if not user_text.strip():
            return ""
        try:
            results = self.memory.recall(user_text, limit=5)
        except Exception:
            return ""
        return "\n".join(f"- {result.fact.content} ({result.fact.source})" for result in results)


def format_memory_result(result: MemorySearchResult) -> str:
    record = result.record
    title = record.title or record.key or record.id
    content = summarize_memory_content(record.content)
    provenance = record.metadata.get("provenance") or record.source or result.source
    return (
        f"  - [{record.layer}] {title}: {content} "
        f"(source: {provenance}; reason: {result.reason})"
    )


def summarize_memory_content(content: str, max_chars: int = 240) -> str:
    compact = " ".join(content.split())
    if len(compact) <= max_chars:
        return compact
    return compact[:max_chars].rstrip() + "..."


def truncate(text: str, max_chars: int) -> str:
    if len(text) <= max_chars:
        return text
    return text[:max_chars].rstrip() + "\n[truncated]"
