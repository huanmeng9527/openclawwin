from __future__ import annotations

from dataclasses import dataclass, field
from typing import Any, Protocol
from uuid import uuid4

from .hooks import HookEngine
from .policies import PolicyEngine
from .prompt import PromptAssembler
from .sessions import SessionRecord
from .tools import ToolRegistry


NO_REPLY = "NO_REPLY"


@dataclass(frozen=True)
class ToolCall:
    name: str
    args: dict[str, Any] = field(default_factory=dict)


@dataclass(frozen=True)
class ModelOutput:
    text: str
    tool_calls: tuple[ToolCall, ...] = ()


class ModelProvider(Protocol):
    def generate(self, *, system: str, user_text: str, session: SessionRecord) -> ModelOutput:
        """Run model inference and optionally request tool calls."""


class EchoModelProvider:
    def generate(self, *, system: str, user_text: str, session: SessionRecord) -> ModelOutput:
        if user_text.strip().lower().startswith("heartbeat"):
            return ModelOutput("HEARTBEAT_OK")
        return ModelOutput(f"Echo: {user_text}")


@dataclass(frozen=True)
class AgentRunResult:
    run_id: str
    status: str
    output: str
    summary: str
    events: tuple[dict[str, Any], ...] = ()
    no_reply: bool = False


class AgentRuntime:
    def __init__(
        self,
        *,
        model: ModelProvider,
        prompt_assembler: PromptAssembler,
        tool_registry: ToolRegistry,
        hooks: HookEngine | None = None,
        policy_engine: PolicyEngine | None = None,
        timeout_seconds: int = 600,
    ) -> None:
        self.model = model
        self.prompt_assembler = prompt_assembler
        self.tool_registry = tool_registry
        self.hooks = hooks or HookEngine()
        self.policy_engine = policy_engine
        self.timeout_seconds = timeout_seconds

    def run(self, session: SessionRecord, user_text: str, *, heartbeat: bool = False) -> AgentRunResult:
        return self.run_with_context(session, user_text, heartbeat=heartbeat)

    def run_with_context(
        self,
        session: SessionRecord,
        user_text: str,
        *,
        heartbeat: bool = False,
        user_id: str | None = None,
        lane_id: str | None = None,
        memory_budget_chars: int | None = None,
        memory_context: dict[str, Any] | None = None,
    ) -> AgentRunResult:
        run_id = uuid4().hex
        context = {"runId": run_id, "session": session, "userText": user_text}
        self.hooks.emit("before_agent_start", context)
        prompt = self.prompt_assembler.assemble(
            session,
            user_text=user_text,
            heartbeat=heartbeat,
            user_id=user_id,
            lane_id=lane_id,
            memory_budget_chars=memory_budget_chars,
            memory_context=memory_context,
        )
        model_output = self.model.generate(system=prompt.system, user_text=user_text, session=session)
        events: list[dict[str, Any]] = []
        tool_results = []
        for tool_call in model_output.tool_calls:
            self.hooks.emit("before_tool_call", {"runId": run_id, "tool": tool_call.name, "args": tool_call.args})
            if self.policy_engine is not None:
                decision = self.policy_engine.enforce_tool_call(session, tool_call.name, tool_call.args)
                events.append(
                    {
                        "event": "policy:tool",
                        "tool": tool_call.name,
                        "allowed": decision.allowed,
                        "reason": decision.reason,
                    }
                )
            events.append({"event": "tool:start", "tool": tool_call.name})
            result = self.tool_registry.call(tool_call.name, tool_call.args, agent_id=session.agent_id)
            tool_results.append({"tool": tool_call.name, "result": result})
            events.append({"event": "tool:end", "tool": tool_call.name, "result": result})
            self.hooks.emit("after_tool_call", {"runId": run_id, "tool": tool_call.name, "result": result})
        output = filter_no_reply(model_output.text)
        no_reply = model_output.text.strip() == NO_REPLY or output.strip() == ""
        if tool_results and output:
            output = output + "\n" + format_tool_results(tool_results)
        summary = output[:240] if output else "NO_REPLY"
        result = AgentRunResult(
            run_id=run_id,
            status="completed",
            output=output,
            summary=summary,
            events=tuple(events),
            no_reply=no_reply,
        )
        self.hooks.emit("agent_end", {"runId": run_id, "result": result})
        return result


def filter_no_reply(text: str) -> str:
    return text.replace(NO_REPLY, "").strip()


def format_tool_results(tool_results: list[dict[str, Any]]) -> str:
    lines = []
    for item in tool_results:
        lines.append(f"[tool:{item['tool']}] {item['result']}")
    return "\n".join(lines)
