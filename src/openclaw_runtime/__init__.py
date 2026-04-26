"""Reference OpenClaw runtime architecture."""

from .agent import AgentRuntime, EchoModelProvider, ModelOutput
from .audit import AuditAction, AuditEvent, AuditLogger, AuditResult
from .gateway import Gateway, GatewayConfig, TLSConfig
from .messaging import ChannelBridge, InternalMessage
from .policies import (
    ApprovalPolicy,
    ApprovalRequired,
    ChannelAllowlistPolicy,
    MessageSendPolicy,
    PolicyDecision,
    PolicyDenied,
    PolicyEngine,
)
from .sandbox import (
    DockerSandboxRunner,
    PodmanSandboxRunner,
    SandboxConfig,
    SandboxManager,
    SandboxPlan,
    SandboxResult,
    SandboxRunner,
)
from .sessions import SessionManager, SessionRecord

__all__ = [
    "AgentRuntime",
    "AuditAction",
    "AuditEvent",
    "AuditLogger",
    "AuditResult",
    "ChannelBridge",
    "DockerSandboxRunner",
    "EchoModelProvider",
    "Gateway",
    "GatewayConfig",
    "InternalMessage",
    "MessageSendPolicy",
    "ModelOutput",
    "PodmanSandboxRunner",
    "PolicyDecision",
    "PolicyDenied",
    "PolicyEngine",
    "SandboxConfig",
    "SandboxManager",
    "SandboxPlan",
    "SandboxResult",
    "SandboxRunner",
    "SessionManager",
    "SessionRecord",
    "TLSConfig",
]
