from __future__ import annotations

import hashlib
import json
import time
from dataclasses import dataclass, field
from typing import Any

from .audit import AuditAction, AuditLogger, AuditResult
from .messaging import InternalMessage
from .sandbox import SandboxManager, SandboxPlan
from .security import DeviceTrustStore
from .sessions import SessionRecord
from .tools import ToolPolicy


@dataclass(frozen=True)
class PolicyDecision:
    allowed: bool
    reason: str
    layer: str
    action: str
    subject: str = ""
    requires_approval: bool = False
    approval_id: str | None = None
    sandbox_plan: SandboxPlan | None = None
    metadata: dict[str, Any] = field(default_factory=dict)

    def raise_if_blocked(self) -> "PolicyDecision":
        if self.requires_approval:
            raise ApprovalRequired(self)
        if not self.allowed:
            raise PolicyDenied(self)
        return self


class PolicyDenied(PermissionError):
    def __init__(self, decision: PolicyDecision) -> None:
        self.decision = decision
        super().__init__(decision.reason)


class ApprovalRequired(PermissionError):
    def __init__(self, decision: PolicyDecision) -> None:
        self.decision = decision
        super().__init__(decision.reason)


@dataclass
class ApprovalRequest:
    id: str
    action: str
    subject: str
    context: dict[str, Any]
    status: str = "pending"


@dataclass
class ChannelAllowlistPolicy:
    allowed_channels: set[str] = field(default_factory=set)
    denied_channels: set[str] = field(default_factory=set)
    allow_system: bool = True

    def decide(self, message: InternalMessage) -> PolicyDecision:
        channel = message.channel
        if self.allow_system and channel == "system":
            return allow("channel", "channel.receive", channel, "system channel allowed")
        if channel in self.denied_channels:
            return deny("channel", "channel.receive", channel, f"channel denied: {channel}")
        if self.allowed_channels and channel not in self.allowed_channels:
            return deny("channel", "channel.receive", channel, f"channel not allowlisted: {channel}")
        return allow("channel", "channel.receive", channel, f"channel allowed: {channel}")


@dataclass
class ApprovalPolicy:
    required_actions: set[str] = field(default_factory=set)
    auto_approve: bool = True
    pending: dict[str, ApprovalRequest] = field(default_factory=dict)
    approved: set[str] = field(default_factory=set)
    denied: set[str] = field(default_factory=set)

    def decide(self, action: str, subject: str, context: dict[str, Any] | None = None) -> PolicyDecision:
        context = context or {}
        approval_id = self.approval_id(action, subject, context)
        if approval_id in self.denied:
            return deny("approval", action, subject, f"approval denied: {approval_id}", approval_id=approval_id)
        if action not in self.required_actions or self.auto_approve or approval_id in self.approved:
            return allow("approval", action, subject, "approval not required", approval_id=approval_id)
        self.pending.setdefault(
            approval_id,
            ApprovalRequest(
                id=approval_id,
                action=action,
                subject=subject,
                context=dict(context),
            ),
        )
        return PolicyDecision(
            allowed=False,
            reason=f"approval required: {approval_id}",
            layer="approval",
            action=action,
            subject=subject,
            requires_approval=True,
            approval_id=approval_id,
        )

    def approve(self, approval_id: str) -> None:
        self.approved.add(approval_id)
        self.denied.discard(approval_id)
        if approval_id in self.pending:
            self.pending[approval_id].status = "approved"

    def deny(self, approval_id: str) -> None:
        self.denied.add(approval_id)
        self.approved.discard(approval_id)
        if approval_id in self.pending:
            self.pending[approval_id].status = "denied"

    def approval_id(self, action: str, subject: str, context: dict[str, Any]) -> str:
        explicit = context.get("approval_id") or context.get("idempotency_key")
        if explicit:
            return str(explicit)
        stable_context = {
            "action": action,
            "subject": subject,
            "session_key": context.get("session_key"),
            "agent_id": context.get("agent_id"),
        }
        encoded = json.dumps(stable_context, ensure_ascii=False, sort_keys=True, default=str)
        return hashlib.sha256(encoded.encode("utf-8")).hexdigest()[:16]


@dataclass
class MessageSendPolicy:
    allowed_channels: set[str] = field(default_factory=set)
    denied_channels: set[str] = field(default_factory=set)
    allow_groups: bool = True
    allow_system: bool = True
    max_chars: int | None = None

    def decide(self, session: SessionRecord, content: str) -> PolicyDecision:
        channel = session.channel
        if self.allow_system and channel == "system":
            return allow("message", "message.send", channel, "system message allowed")
        if channel in self.denied_channels:
            return deny("message", "message.send", channel, f"message channel denied: {channel}")
        if self.allowed_channels and channel not in self.allowed_channels:
            return deny("message", "message.send", channel, f"message channel not allowlisted: {channel}")
        if session.group_id is not None and not self.allow_groups:
            return deny("message", "message.send", session.group_id, "group message sending denied")
        if self.max_chars is not None and len(content) > self.max_chars:
            return deny("message", "message.send", channel, "message exceeds max_chars")
        return allow("message", "message.send", channel, f"message allowed: {channel}")


class PolicyEngine:
    def __init__(
        self,
        *,
        channel_policy: ChannelAllowlistPolicy | None = None,
        approval_policy: ApprovalPolicy | None = None,
        message_send_policy: MessageSendPolicy | None = None,
        tool_policy: ToolPolicy | None = None,
        trust_store: DeviceTrustStore | None = None,
        sandbox_manager: SandboxManager | None = None,
        audit_logger: AuditLogger | None = None,
    ) -> None:
        self.channel_policy = channel_policy or ChannelAllowlistPolicy()
        self.approval_policy = approval_policy or ApprovalPolicy()
        self.message_send_policy = message_send_policy or MessageSendPolicy()
        self.tool_policy = tool_policy or ToolPolicy(default_allow=True)
        self.trust_store = trust_store or DeviceTrustStore()
        self.sandbox_manager = sandbox_manager or SandboxManager()
        self.audit_logger = audit_logger

    def _audit(
        self,
        action: AuditAction,
        subject_type: str,
        subject_id: str,
        session_key: str,
        agent_id: str,
        target: str,
        args: dict[str, Any] | None,
        decision: AuditResult,
        reason: str,
        approval_required: bool = False,
        approver: str = "",
        success: bool = True,
        error_detail: str = "",
        **metadata: Any,
    ) -> None:
        if self.audit_logger is None:
            return
        self.audit_logger.log_event(
            action=action,
            subject_type=subject_type,
            subject_id=subject_id,
            session_key=session_key,
            agent_id=agent_id,
            target=target,
            args=args,
            decision=decision,
            decision_reason=reason,
            approval_required=approval_required,
            approver=approver,
            success=success,
            error_detail=error_detail,
            **metadata,
        )

    def decide_connection(
        self,
        *,
        gateway_token: str | None,
        device_id: str | None = None,
        device_token: str | None = None,
    ) -> PolicyDecision:
        if not self.trust_store.authenticate_gateway(gateway_token):
            d = deny("gateway", "gateway.connect", device_id or "unknown", "gateway token rejected")
            self._audit(AuditAction.CONNECTION, "device", device_id or "unknown", "", "",
                        device_id or "unknown", None, AuditResult.DENY, d.reason)
            return d
        if device_id is None:
            d = allow("gateway", "gateway.connect", "anonymous", "gateway token accepted")
            self._audit(AuditAction.CONNECTION, "device", "anonymous", "", "",
                        "anonymous", None, AuditResult.ALLOW, d.reason)
            return d
        if not device_token or not self.trust_store.verify_device(device_id, device_token):
            d = deny("trust", "device.connect", device_id, f"device not trusted: {device_id}")
            self._audit(AuditAction.CONNECTION, "device", device_id, "", "",
                        device_id, None, AuditResult.DENY, d.reason)
            return d
        d = allow("trust", "device.connect", device_id, f"device trusted: {device_id}")
        self._audit(AuditAction.CONNECTION, "device", device_id, "", "",
                    device_id, None, AuditResult.ALLOW, d.reason)
        return d

    def enforce_connection(
        self,
        *,
        gateway_token: str | None,
        device_id: str | None = None,
        device_token: str | None = None,
    ) -> PolicyDecision:
        return self.decide_connection(
            gateway_token=gateway_token,
            device_id=device_id,
            device_token=device_token,
        ).raise_if_blocked()

    def decide_inbound(self, message: InternalMessage) -> PolicyDecision:
        d = self.channel_policy.decide(message)
        self._audit(
            AuditAction.CHANNEL_RECEIVE,
            "user",
            message.peer_id,
            "",
            "",
            message.channel,
            {"text_len": len(message.text), "group_id": message.group_id},
            AuditResult.ALLOW if d.allowed else AuditResult.DENY,
            d.reason,
        )
        return d

    def enforce_inbound(self, message: InternalMessage) -> PolicyDecision:
        return self.decide_inbound(message).raise_if_blocked()

    def decide_tool_call(
        self,
        session: SessionRecord,
        tool_name: str,
        args: dict[str, Any] | None = None,
    ) -> PolicyDecision:
        if not self.tool_policy.allowed(tool_name, agent_id=session.agent_id):
            d = deny("tool", "tool.call", tool_name, f"tool denied: {tool_name}")
            self._audit(AuditAction.TOOL_CALL, "agent", session.agent_id,
                        session.session_key, session.agent_id, tool_name, args,
                        AuditResult.DENY, d.reason)
            return d
        approval = self.approval_policy.decide(
            "tool.call",
            tool_name,
            {
                "session_key": session.session_key,
                "agent_id": session.agent_id,
                "args": args or {},
            },
        )
        if not approval.allowed:
            self._audit(AuditAction.TOOL_CALL, "agent", session.agent_id,
                        session.session_key, session.agent_id, tool_name, args,
                        AuditResult.REQUIRE_APPROVAL, approval.reason,
                        approval_required=True,
                        approval_id=approval.approval_id)
            return approval
        self._audit(AuditAction.TOOL_CALL, "agent", session.agent_id,
                    session.session_key, session.agent_id, tool_name, args,
                    AuditResult.ALLOW if approval.auto_approve else AuditResult.APPROVED,
                    approval.reason,
                    approval_required=False,
                    approver="auto" if approval.auto_approve else "")
        return allow("tool", "tool.call", tool_name, f"tool allowed: {tool_name}", approval_id=approval.approval_id)

    def enforce_tool_call(
        self,
        session: SessionRecord,
        tool_name: str,
        args: dict[str, Any] | None = None,
    ) -> PolicyDecision:
        return self.decide_tool_call(session, tool_name, args).raise_if_blocked()

    def decide_message_send(self, session: SessionRecord, content: str) -> PolicyDecision:
        message_decision = self.message_send_policy.decide(session, content)
        if not message_decision.allowed:
            self._audit(AuditAction.MESSAGE_SEND, "agent", session.agent_id,
                        session.session_key, session.agent_id, session.channel,
                        {"content_len": len(content), "group_id": session.group_id},
                        AuditResult.DENY, message_decision.reason)
            return message_decision
        approval = self.approval_policy.decide(
            "message.send",
            session.channel,
            {
                "session_key": session.session_key,
                "agent_id": session.agent_id,
                "channel": session.channel,
                "group_id": session.group_id,
            },
        )
        if not approval.allowed:
            self._audit(AuditAction.MESSAGE_SEND, "agent", session.agent_id,
                        session.session_key, session.agent_id, session.channel,
                        {"content_len": len(content), "group_id": session.group_id},
                        AuditResult.REQUIRE_APPROVAL, approval.reason,
                        approval_required=True, approval_id=approval.approval_id)
            return approval
        self._audit(AuditAction.MESSAGE_SEND, "agent", session.agent_id,
                    session.session_key, session.agent_id, session.channel,
                    {"content_len": len(content), "group_id": session.group_id},
                    AuditResult.ALLOW, approval.reason,
                    approval_required=False, approver="auto" if approval.auto_approve else "")
        return allow(
            "message",
            "message.send",
            session.channel,
            f"message allowed: {session.channel}",
            approval_id=approval.approval_id,
        )

    def enforce_message_send(self, session: SessionRecord, content: str) -> PolicyDecision:
        return self.decide_message_send(session, content).raise_if_blocked()

    def sandbox_plan_for(self, session: SessionRecord) -> SandboxPlan:
        plan = self.sandbox_manager.plan_for(session)
        self._audit(
            AuditAction.SANDBOX_PLAN, "agent", session.agent_id,
            session.session_key, session.agent_id, "sandbox",
            {"enabled": plan.enabled, "scope": plan.scope_key},
            AuditResult.ALLOW if plan.enabled else AuditResult.DENY,
            f"sandbox plan: enabled={plan.enabled}, scope={plan.scope_key}",
        )
        return plan


def allow(
    layer: str,
    action: str,
    subject: str,
    reason: str,
    *,
    approval_id: str | None = None,
    metadata: dict[str, Any] | None = None,
) -> PolicyDecision:
    return PolicyDecision(
        allowed=True,
        reason=reason,
        layer=layer,
        action=action,
        subject=subject,
        approval_id=approval_id,
        metadata=metadata or {},
    )


def deny(
    layer: str,
    action: str,
    subject: str,
    reason: str,
    *,
    approval_id: str | None = None,
    metadata: dict[str, Any] | None = None,
) -> PolicyDecision:
    return PolicyDecision(
        allowed=False,
        reason=reason,
        layer=layer,
        action=action,
        subject=subject,
        approval_id=approval_id,
        metadata=metadata or {},
    )
