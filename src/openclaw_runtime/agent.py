from __future__ import annotations

import json
import logging
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any, Protocol
from uuid import uuid4

from .hooks import HookEngine
from .policies import PolicyDecision, PolicyEngine
from .prompt import PromptAssembler
from .sandbox import SandboxManager, SandboxRunner, SandboxResult
from .sessions import SessionRecord
from .tools import ToolRegistry

logger = logging.getLogger(__name__)


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
        sandbox_manager: SandboxManager | None = None,
        approval_broker: Any = None,  # ApprovalBroker — see approval.py
        timeout_seconds: int = 600,
    ) -> None:
        self.model = model
        self.prompt_assembler = prompt_assembler
        self.tool_registry = tool_registry
        self.hooks = hooks or HookEngine()
        self.policy_engine = policy_engine
        self.sandbox_manager = sandbox_manager
        self.approval_broker = approval_broker  # set by Gateway
        self.timeout_seconds = timeout_seconds

    def run(self, session: SessionRecord, user_text: str, *, heartbeat: bool = False) -> AgentRunResult:
        run_id = uuid4().hex
        context = {"runId": run_id, "session": session, "userText": user_text}
        self.hooks.emit("before_agent_start", context)
        prompt = self.prompt_assembler.assemble(session, user_text=user_text, heartbeat=heartbeat)
        model_output = self.model.generate(system=prompt.system, user_text=user_text, session=session)
        events: list[dict[str, Any]] = []
        tool_results = []
        for tool_call in model_output.tool_calls:
            self.hooks.emit("before_tool_call", {"runId": run_id, "tool": tool_call.name, "args": tool_call.args})

            # ── Policy decision (non-blocking) ────────────────────────────────
            decision: PolicyDecision | None = None
            if self.policy_engine is not None:
                decision = self.policy_engine.decide_tool_call(session, tool_call.name, tool_call.args)
                events.append(
                    {
                        "event": "policy:tool",
                        "tool": tool_call.name,
                        "allowed": decision.allowed,
                        "reason": decision.reason,
                        "requires_approval": decision.requires_approval,
                    }
                )

                if not decision.allowed:
                    events.append({"event": "tool:rejected", "tool": tool_call.name, "reason": decision.reason})
                    continue

                # ── Human-in-the-loop approval ─────────────────────────────────
                # If requires_approval and we have a broker, submit and wait
                if decision.requires_approval and self.approval_broker is not None:
                    approval_id = decision.approval_id or ""
                    # Submit + notify + wait (blocks until human approves/denies/times out)
                    try:
                        record = self.approval_broker.request_and_wait(
                            action="tool.call",
                            subject=tool_call.name,
                            context={
                                "session_key": session.session_key,
                                "agent_id": session.agent_id,
                                "args": tool_call.args or {},
                            },
                        )
                        events.append({
                            "event": "tool:approval_resolved",
                            "tool": tool_call.name,
                            "approval_id": approval_id,
                            "status": record.status.value,
                            "resolved_by": record.resolved_by,
                        })
                        if record.status.value != "approved":
                            events.append({"event": "tool:rejected", "tool": tool_call.name,
                                          "reason": f"approval {record.status.value}: {record.resolved_reason}"})
                            continue
                    except Exception as exc:
                        logger.error("approval broker error: %s", exc)
                        events.append({"event": "tool:rejected", "tool": tool_call.name,
                                      "reason": f"approval broker error: {exc}"})
                        continue

            events.append({"event": "tool:start", "tool": tool_call.name})
            try:
                # ── Sandbox dispatch ─────────────────────────────────────────
                # Check if this tool should run inside a container
                sandboxed = (
                    self.sandbox_manager is not None
                    and self.sandbox_manager.should_sandbox_tool(tool_call.name)
                )
                runner = (
                    self.sandbox_manager.get_runner()
                    if sandboxed and self.sandbox_manager is not None
                    else None
                )

                if runner is not None:
                    # High-risk tool: run inside Docker/Podman container
                    workspace = self.prompt_assembler.workspace
                    events.append({"event": "tool:sandboxed", "tool": tool_call.name, "runner": type(runner).__name__})
                    sb_result = runner.run(
                        self._tool_to_argv(tool_call.name, tool_call.args),
                        workspace_path=workspace,
                        env={},
                        timeout_seconds=float(self.timeout_seconds),
                    )
                    result = {
                        "sandboxed": True,
                        "ok": sb_result.ok,
                        "stdout": sb_result.stdout,
                        "stderr": sb_result.stderr,
                        "exit_code": sb_result.exit_code,
                        "duration_ms": sb_result.duration_ms,
                    }
                    tool_results.append({"tool": tool_call.name, "result": result})
                    events.append({"event": "tool:end", "tool": tool_call.name, "result": result})
                    self.hooks.emit("after_tool_call", {"runId": run_id, "tool": tool_call.name, "result": result})
                else:
                    # Normal (low-risk) tool: run directly on host
                    result = self.tool_registry.call(tool_call.name, tool_call.args, agent_id=session.agent_id)
                    tool_results.append({"tool": tool_call.name, "result": result})
                    events.append({"event": "tool:end", "tool": tool_call.name, "result": result})
                    self.hooks.emit("after_tool_call", {"runId": run_id, "tool": tool_call.name, "result": result})

            except Exception as exc:
                logger.warning(
                    "tool '%s' call failed: %s",
                    tool_call.name,
                    exc,
                    exc_info=True,
                )
                tool_results.append({"tool": tool_call.name, "error": str(exc)})
                events.append({"event": "tool:error", "tool": tool_call.name, "error": type(exc).__name__})
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

    @staticmethod
    def _tool_to_argv(tool_name: str, args: dict[str, Any]) -> list[str]:
        """Convert a tool call to an argv list for shell execution in container.

        This is a best-effort conversion for sandboxed tools that need to
        run shell commands.  Tool implementors should provide explicit argv
        if possible; this generic fallback encodes args as JSON.
        """
        import shlex

        if tool_name == "exec":
            # args: { "command": "ls -la" }
            cmd = args.get("command", "")
            return ["sh", "-c", cmd]
        if tool_name == "shell" or tool_name == "bash":
            cmd = args.get("cmd", args.get("command", ""))
            return ["sh", "-c", cmd]
        if tool_name == "run_code" or tool_name == "python_eval":
            code = args.get("code", args.get("script", ""))
            return ["python3", "-c", code]
        if tool_name == "subprocess":
            argv = args.get("argv", [])
            if argv:
                return argv
            cmd = args.get("command", "")
            return ["sh", "-c", cmd]
        # Generic fallback: encode as JSON and eval
        encoded = json.dumps(args, ensure_ascii=False)
        return ["python3", "-c", f"import json,sys; print(json.loads(sys.stdin.read()))", "--json", encoded]


def filter_no_reply(text: str) -> str:
    return text.replace(NO_REPLY, "").strip()


def format_tool_results(tool_results: list[dict[str, Any]]) -> str:
    lines = []
    for item in tool_results:
        lines.append(f"[tool:{item['tool']}] {item['result']}")
    return "\n".join(lines)
