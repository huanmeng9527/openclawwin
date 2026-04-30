"""Reference OpenClaw runtime architecture."""

from .agent import AgentRuntime, EchoModelProvider, ModelOutput
from .gateway import Gateway, GatewayConfig
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
from .sessions import SessionManager, SessionRecord

__all__ = [
    "AgentRuntime",
    "ChannelBridge",
    "EchoModelProvider",
    "Gateway",
    "GatewayConfig",
    "InternalMessage",
    "ApprovalPolicy",
    "ApprovalRequired",
    "ChannelAllowlistPolicy",
    "MessageSendPolicy",
    "ModelOutput",
    "PolicyDecision",
    "PolicyDenied",
    "PolicyEngine",
    "SessionManager",
    "SessionRecord",
]
