from __future__ import annotations

from dataclasses import dataclass
from pathlib import Path

from openclaw_memory import MEMORY_READ, MemoryPolicyGate, MemoryRouter, WorkspaceMemory

from .agent import AgentRuntime, AgentRunResult, EchoModelProvider
from .hooks import HookEngine, PluginContext, PluginManager
from .messaging import ChannelBridge, DictChannelBridge, InternalMessage
from .nodes import NodeRegistry
from .policies import (
    ApprovalPolicy,
    ChannelAllowlistPolicy,
    MessageSendPolicy,
    PolicyEngine,
)
from .prompt import PromptAssembler
from .queue import Command, LaneAwareCommandQueue
from .sandbox import SandboxConfig, SandboxManager
from .scheduler import CronScheduler, HeartbeatSystem, ScheduledJob
from .security import DeviceTrustStore
from .sessions import SessionManager, SessionRecord
from .skills import SkillLoader
from .tools import ToolPolicy, ToolRegistry, register_memory_router_tools, register_memory_tools


@dataclass(frozen=True)
class GatewayConfig:
    workspace: str | Path
    agent_id: str = "default"
    dm_scope: str = "per-channel-peer"
    max_concurrent: int = 4
    subagent_concurrent: int = 8
    sandbox: SandboxConfig = SandboxConfig()
    gateway_token: str | None = None
    allowed_channels: tuple[str, ...] = ()
    denied_channels: tuple[str, ...] = ()
    outbound_allowed_channels: tuple[str, ...] = ()
    outbound_denied_channels: tuple[str, ...] = ()
    require_approval_for: tuple[str, ...] = ()
    auto_approve: bool = True
    prompt_memory_permissions: tuple[str, ...] = (MEMORY_READ,)
    prompt_memory_budget_chars: int = 4_000


@dataclass(frozen=True)
class GatewayResponse:
    session: SessionRecord
    run: AgentRunResult
    delivered: bool


class Gateway:
    def __init__(
        self,
        config: GatewayConfig,
        *,
        runtime: AgentRuntime | None = None,
        memory: WorkspaceMemory | None = None,
        tool_registry: ToolRegistry | None = None,
        hooks: HookEngine | None = None,
        policy_engine: PolicyEngine | None = None,
    ) -> None:
        self.config = config
        self.workspace = Path(config.workspace)
        self.workspace.mkdir(parents=True, exist_ok=True)
        self.memory = memory or WorkspaceMemory(self.workspace)
        self.memory.init()
        self.hooks = hooks or HookEngine()
        self.sessions = SessionManager(
            self.workspace,
            agent_id=config.agent_id,
            dm_scope=config.dm_scope,
        )
        self.queue = LaneAwareCommandQueue(
            max_concurrent=config.max_concurrent,
            subagent_concurrent=config.subagent_concurrent,
        )
        self.tools = tool_registry or ToolRegistry(ToolPolicy(default_allow=True))
        register_memory_tools(self.tools, self.memory)
        self.skills = SkillLoader(self.workspace)
        self.sandbox = SandboxManager(config.sandbox)
        self.nodes = NodeRegistry()
        self.trust = DeviceTrustStore(gateway_token=config.gateway_token)
        self.policy = policy_engine or PolicyEngine(
            channel_policy=ChannelAllowlistPolicy(
                allowed_channels=set(config.allowed_channels),
                denied_channels=set(config.denied_channels),
            ),
            approval_policy=ApprovalPolicy(
                required_actions=set(config.require_approval_for),
                auto_approve=config.auto_approve,
            ),
            message_send_policy=MessageSendPolicy(
                allowed_channels=set(config.outbound_allowed_channels),
                denied_channels=set(config.outbound_denied_channels),
            ),
            tool_policy=self.tools.policy,
            trust_store=self.trust,
            sandbox_manager=self.sandbox,
        )
        self.memory_router = MemoryRouter(
            self.workspace,
            policy_gate=MemoryPolicyGate(self.policy),
        )
        register_memory_router_tools(self.tools, self.memory_router)
        self.bridges: dict[str, ChannelBridge] = {"dict": DictChannelBridge("dict")}
        self.cron = CronScheduler()
        self.heartbeat = HeartbeatSystem()
        self.plugins = PluginManager(PluginContext(hooks=self.hooks, services={"gateway": self}))
        self.runtime = runtime or AgentRuntime(
            model=EchoModelProvider(),
            prompt_assembler=PromptAssembler(
                self.workspace,
                memory=self.memory,
                memory_router=self.memory_router,
                tool_registry=self.tools,
                skill_loader=self.skills,
                memory_budget_chars=config.prompt_memory_budget_chars,
            ),
            tool_registry=self.tools,
            hooks=self.hooks,
            policy_engine=self.policy,
        )
        if runtime is not None:
            self.runtime.policy_engine = self.policy

    def authorize_connection(
        self,
        *,
        gateway_token: str | None,
        device_id: str | None = None,
        device_token: str | None = None,
    ):
        return self.policy.enforce_connection(
            gateway_token=gateway_token,
            device_id=device_id,
            device_token=device_token,
        )

    def register_bridge(self, bridge: ChannelBridge) -> None:
        self.bridges[bridge.name] = bridge

    def receive_native(self, channel: str, event: dict[str, object]) -> GatewayResponse:
        bridge = self.bridges[channel]
        return self.receive(bridge.normalize(event))

    def receive(self, message: InternalMessage) -> GatewayResponse:
        self.policy.enforce_inbound(message)
        self.hooks.emit("message_received", {"message": message})
        session = self.sessions.resolve_message(message)
        self.sessions.append_transcript(
            session,
            "user",
            message.text,
            metadata={"channel": message.channel, "messageId": message.message_id},
        )
        command = Command(session_key=session.session_key, payload=(session, message))
        response = self.queue.dispatch(command, self._run_message_command)
        self.hooks.emit("message_sent", {"message": message, "response": response})
        return response

    def run_heartbeat(self) -> str | None:
        return self.heartbeat.tick(lambda prompt: self._run_system_turn(prompt, heartbeat=True).run.output)

    def run_due_cron(self) -> list[str]:
        return self.cron.run_due(self._run_cron_job)

    def _run_message_command(self, command: Command[tuple[SessionRecord, InternalMessage]]) -> GatewayResponse:
        session, message = command.payload
        sandbox_plan = self.policy.sandbox_plan_for(session)
        self.hooks.emit("sandbox:plan", {"session": session, "plan": sandbox_plan})
        run = self.runtime.run_with_context(
            session,
            message.text,
            user_id=message.peer_id,
            lane_id=command.lane,
            memory_budget_chars=self.config.prompt_memory_budget_chars,
            memory_context={
                "session_id": session.session_id,
                "agent_id": session.agent_id,
                "user_id": message.peer_id,
                "lane_id": command.lane,
                "permissions": set(self.config.prompt_memory_permissions),
            },
        )
        delivered = False
        if not run.no_reply:
            self.policy.enforce_message_send(session, run.output)
            delivered = True
        if delivered:
            self.sessions.append_transcript(session, "assistant", run.output, metadata={"runId": run.run_id})
        return GatewayResponse(session=session, run=run, delivered=delivered)

    def _run_system_turn(self, prompt: str, *, heartbeat: bool = False) -> GatewayResponse:
        message = InternalMessage(channel="system", peer_id="main", text=prompt)
        session = self.sessions.resolve_message(message)
        run = self.runtime.run_with_context(
            session,
            prompt,
            heartbeat=heartbeat,
            user_id=message.peer_id,
            lane_id="system",
            memory_budget_chars=self.config.prompt_memory_budget_chars,
            memory_context={
                "session_id": session.session_id,
                "agent_id": session.agent_id,
                "user_id": message.peer_id,
                "lane_id": "system",
                "permissions": set(self.config.prompt_memory_permissions),
            },
        )
        delivered = False
        if not run.no_reply:
            self.policy.enforce_message_send(session, run.output)
            delivered = True
        if delivered:
            self.sessions.append_transcript(session, "assistant", run.output, metadata={"runId": run.run_id})
        return GatewayResponse(session=session, run=run, delivered=delivered)

    def _run_cron_job(self, job: ScheduledJob) -> str:
        response = self._run_system_turn(job.prompt)
        return response.run.output
