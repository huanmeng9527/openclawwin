from __future__ import annotations

from dataclasses import dataclass
from datetime import date, timedelta
from pathlib import Path

from openclaw_memory import WorkspaceMemory

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
        bootstrap_max_chars: int = 20_000,
    ) -> None:
        self.workspace = Path(workspace)
        self.memory = memory
        self.tool_registry = tool_registry
        self.skill_loader = skill_loader
        self.bootstrap_max_chars = bootstrap_max_chars

    def assemble(self, session: SessionRecord, *, user_text: str, heartbeat: bool = False) -> PromptBundle:
        sections = {
            "safety": self._safety_guardrails(),
            "runtime": self._runtime_metadata(session, heartbeat=heartbeat),
            "tools": self._tools_section(session.agent_id),
            "skills": self._skills_section(),
            "workspace": self._workspace_context(),
            "memory": self._memory_context(session),
            "recall": self._semantic_recall(user_text),
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
            f"private={str(session.private).lower()}\n"
            f"heartbeat={str(heartbeat).lower()}"
        )

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

    def _memory_context(self, session: SessionRecord) -> str:
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
        return "\n\n".join(chunks)

    def _semantic_recall(self, user_text: str) -> str:
        if not user_text.strip():
            return ""
        try:
            results = self.memory.recall(user_text, limit=5)
        except Exception:
            return ""
        return "\n".join(f"- {result.fact.content} ({result.fact.source})" for result in results)


def truncate(text: str, max_chars: int) -> str:
    if len(text) <= max_chars:
        return text
    return text[:max_chars].rstrip() + "\n[truncated]"
