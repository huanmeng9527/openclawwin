"""Reference OpenClaw runtime architecture."""

from .agent import AgentRuntime, EchoModelProvider, ModelOutput
from .approval import (
    ApprovalBroker,
    ApprovalChannel,
    ApprovalRecord,
    ApprovalServer,
    ApprovalStatus,
    FeishuApprovalChannel,
    WebhookApprovalChannel,
)
from .rbac import (
    Permission,
    RBAC,
    RBACDecision,
    Role,
)
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
    "ApprovalBroker",
    "ApprovalChannel",
    "ApprovalRecord",
    "ApprovalServer",
    "ApprovalStatus",
    "AuditAction",
    "AuditEvent",
    "AuditLogger",
    "AuditResult",
    "ChannelBridge",
    "DockerSandboxRunner",
    "EchoModelProvider",
    "FeishuApprovalChannel",
    "Gateway",
    "GatewayConfig",
    "InternalMessage",
    "MessageSendPolicy",
    "ModelOutput",
    "Permission",
    "PodmanSandboxRunner",
    "PolicyDecision",
    "PolicyDenied",
    "PolicyEngine",
    "RBAC",
    "RBACDecision",
    "Role",
    "SandboxConfig",
    "SandboxManager",
    "SandboxPlan",
    "SandboxResult",
    "SandboxRunner",
    "SessionManager",
    "SessionRecord",
    "TLSConfig",
    "WebhookApprovalChannel",
]
