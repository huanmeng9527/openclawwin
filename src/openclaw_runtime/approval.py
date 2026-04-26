"""
Human-in-the-loop Approval Broker.

When PolicyEngine requires approval for a high-risk action, ApprovalBroker:
  1. Creates a pending approval record with timeout
  2. Sends an approval request to a real channel (Feishu / Telegram / Webhook)
  3. Waits (polls) for human resolution
  4. Returns the decision to PolicyEngine

No more programmatic `.approve()` — all approvals go through a human.

Usage:
    broker = ApprovalBroker(gateway=my_gateway)

    # Register a channel (Feishu example)
    from openclaw_runtime.approval import FeishuApprovalChannel
    broker.register_channel(FeishuApprovalChannel(
        bot_token="fp.XXXXXXXX",
        chat_id="ou_xxxxx",
    ))

    # Make it available in the gateway
    gateway.approval_broker = broker

    # High-risk action now triggers real human approval
    decision = gateway.policy.decide_tool_call(session, "exec", {"command": "rm -rf /"})
    # → returns REQUIRE_APPROVAL, blocks execution, sends Feishu card
    # Human approves in Feishu → broker resolves → tool executes
"""

from __future__ import annotations

import json
import logging
import threading
import time
import uuid
from abc import ABC, abstractmethod
from dataclasses import dataclass, field
from datetime import datetime, timezone
from enum import Enum
from pathlib import Path
from typing import Any

logger = logging.getLogger(__name__)


# ─────────────────────────────────────────────────────────────────────────────
# Approval State
# ─────────────────────────────────────────────────────────────────────────────

class ApprovalStatus(str, Enum):
    PENDING = "pending"
    APPROVED = "approved"
    DENIED = "denied"
    EXPIRED = "expired"
    TIMEOUT = "timeout"


@dataclass
class ApprovalRecord:
    id: str
    action: str
    subject: str
    context: dict[str, Any]
    status: ApprovalStatus = ApprovalStatus.PENDING
    created_at: str = field(default_factory=lambda: datetime.now(timezone.utc).isoformat())
    resolved_at: str | None = None
    resolved_by: str = ""  # "human:<name>" or "system:timeout"
    resolved_reason: str = ""

    def is_resolved(self) -> bool:
        return self.status in (ApprovalStatus.APPROVED, ApprovalStatus.DENIED, ApprovalStatus.EXPIRED, ApprovalStatus.TIMEOUT)

    def age_seconds(self) -> float:
        created = datetime.fromisoformat(self.created_at)
        return (datetime.now(timezone.utc) - created).total_seconds()


# ─────────────────────────────────────────────────────────────────────────────
# Approval Channel Protocol
# ─────────────────────────────────────────────────────────────────────────────

class ApprovalChannel(ABC):
    """Abstract approval channel — implement to add Slack, Telegram, etc."""

    @abstractmethod
    def send_request(self, record: ApprovalRecord) -> bool:
        """Send an approval request to a human. Return True on success."""

    @abstractmethod
    def send_resolution(self, record: ApprovalRecord, *, approved: bool) -> None:
        """Confirm to the user that the request was resolved."""


# ─────────────────────────────────────────────────────────────────────────────
# Approval Broker
# ─────────────────────────────────────────────────────────────────────────────

class ApprovalBroker:
    """Manages the full approval lifecycle with human-in-the-loop.

    Workflow:
      decide_*() in PolicyEngine returns REQUIRE_APPROVAL
        → broker.submit() creates pending record
        → broker.notify() sends to registered channels
        → broker.wait() blocks until resolved or timed out
        → PolicyEngine enforces the actual allow/deny

    Access control:
      resolve() requires APPROVAL_ACT permission checked via rbac.check().
      Set broker.rbac before use; if no rbac is set, resolve() is open
      (backward-compatible for trusted environments).
    """

    def __init__(
        self,
        *,
        timeout_seconds: float = 300.0,  # 5 minutes default
        poll_interval: float = 1.0,
        rbac: Any = None,  # RBAC instance — checked on resolve()
    ) -> None:
        self.timeout_seconds = timeout_seconds
        self.poll_interval = poll_interval
        self._records: dict[str, ApprovalRecord] = {}
        self._lock = threading.RLock()
        self._channels: list[ApprovalChannel] = []
        self._rbac = rbac

    # ── Channel registration ─────────────────────────────────────────────────

    def register_channel(self, channel: ApprovalChannel) -> None:
        self._channels.append(channel)

    # ── Approval lifecycle ───────────────────────────────────────────────────

    def submit(
        self,
        action: str,
        subject: str,
        context: dict[str, Any],
    ) -> str:
        """Create a pending approval record. Returns approval_id."""
        record = ApprovalRecord(
            id=uuid.uuid4().hex[:12],
            action=action,
            subject=subject,
            context=context,
        )
        with self._lock:
            self._records[record.id] = record
        logger.info(
            "approval submitted: id=%s action=%s subject=%s",
            record.id, action, subject,
        )
        return record.id

    def set_rbac(self, rbac: Any) -> None:
        """Set the RBAC engine for resolve() permission checks."""
        self._rbac = rbac

    def resolve(self, approval_id: str, *, approved: bool, resolved_by: str = "", reason: str = "") -> bool:
        """Resolve a pending approval. Returns True if found and resolved.

        Requires APPROVAL_ACT permission if rbac is configured.
        """
        # ── RBAC enforcement: only operator/admin can approve/deny ──────────
        if self._rbac is not None:
            from .rbac import Permission
            decision = self._rbac.check(
                subject=resolved_by or "anonymous",
                permission=Permission.APPROVAL_ACT,
                resource=f"approval:{approval_id}",
            )
            if not decision.allowed:
                logger.warning(
                    "approval resolve BLOCKED by RBAC: subject=%s reason=%s",
                    resolved_by or "anonymous", decision.reason,
                )
                return False

        with self._lock:
            record = self._records.get(approval_id)
            if record is None:
                logger.warning("approval resolve: not found id=%s", approval_id)
                return False
            if record.is_resolved():
                logger.warning("approval resolve: already resolved id=%s status=%s", approval_id, record.status)
                return False
            record.status = ApprovalStatus.APPROVED if approved else ApprovalStatus.DENIED
            record.resolved_at = datetime.now(timezone.utc).isoformat()
            record.resolved_by = resolved_by or ("human:operator" if approved else "human:operator")
            record.resolved_reason = reason
        logger.info(
            "approval resolved: id=%s status=%s by=%s",
            approval_id, record.status.value, record.resolved_by,
        )
        # Notify channels of resolution
        for ch in self._channels:
            try:
                ch.send_resolution(record, approved=approved)
            except Exception as exc:
                logger.warning("channel resolution notification failed: %s", exc)
        return True

    def get(self, approval_id: str) -> ApprovalRecord | None:
        with self._lock:
            return self._records.get(approval_id)

    def notify(self, approval_id: str) -> bool:
        """Send pending approval to all registered channels. Returns True if any succeeded."""
        record = self.get(approval_id)
        if record is None:
            return False
        success = False
        for ch in self._channels:
            try:
                if ch.send_request(record):
                    success = True
            except Exception as exc:
                logger.warning("channel send_request failed: %s", exc)
        return success

    def wait(self, approval_id: str) -> ApprovalRecord:
        """Block until the approval is resolved or timed out. Returns final record."""
        deadline = time.monotonic() + self.timeout_seconds
        while True:
            record = self.get(approval_id)
            if record is None:
                raise KeyError(f"approval not found: {approval_id}")
            if record.is_resolved():
                return record
            remaining = deadline - time.monotonic()
            if remaining <= 0:
                # Expire it
                self.resolve(approval_id, approved=False, resolved_by="system:timeout", reason=f"timeout after {self.timeout_seconds}s")
                record = self.get(approval_id)
                assert record is not None
                return record
            time.sleep(min(self.poll_interval, remaining))

    # Convenience: submit + notify + wait in one call
    def request_and_wait(
        self,
        action: str,
        subject: str,
        context: dict[str, Any],
    ) -> ApprovalRecord:
        """Submit, notify channels, wait for resolution. Returns final record."""
        approval_id = self.submit(action, subject, context)
        self.notify(approval_id)
        return self.wait(approval_id)


# ─────────────────────────────────────────────────────────────────────────────
# Webhook / HTTP Approval Channel
# ─────────────────────────────────────────────────────────────────────────────

class WebhookApprovalChannel(ApprovalChannel):
    """POST approval request to a webhook URL.

    The webhook receiver is responsible for showing the request to a human
    and calling the resolution endpoint (e.g. GET /approval/{id}/approve).

    Example webhook payload:
      POST https://your-gateway.com/approval/{id}
      {
        "id": "abc123",
        "action": "tool.call",
        "subject": "exec",
        "context": {"args": {"command": "rm -rf /"}},
        "approve_url": "https://your-gateway.com/approval/abc123/approve",
        "deny_url": "https://your-gateway.com/approval/abc123/deny",
        "expires_at": "2026-04-26T12:30:00+00:00"
      }
    """

    def __init__(
        self,
        webhook_url: str,
        *,
        headers: dict[str, str] | None = None,
        timeout: float = 10.0,
    ) -> None:
        self.webhook_url = webhook_url.rstrip("/")
        self.headers = headers or {}
        self.timeout = timeout

    def send_request(self, record: ApprovalRecord) -> bool:
        import urllib.request

        payload = json.dumps({
            "id": record.id,
            "action": record.action,
            "subject": record.subject,
            "context": record.context,
            "approve_url": f"{self.webhook_url}/{record.id}/approve",
            "deny_url": f"{self.webhook_url}/{record.id}/deny",
            "expires_at": _future_iso(seconds=300),
        }, ensure_ascii=False).encode()

        req = urllib.request.Request(
            self.webhook_url,
            data=payload,
            headers={**self.headers, "Content-Type": "application/json"},
            method="POST",
        )
        try:
            with urllib.request.urlopen(req, timeout=self.timeout) as resp:
                return resp.status in (200, 201, 202)
        except Exception as exc:
            logger.error("webhook send failed: %s", exc)
            return False

    def send_resolution(self, record: ApprovalRecord, *, approved: bool) -> None:
        pass  # webhook is fire-and-forget; receiver handles user notification


# ─────────────────────────────────────────────────────────────────────────────
# Feishu Approval Channel
# ─────────────────────────────────────────────────────────────────────────────

class FeishuApprovalChannel(ApprovalChannel):
    """Send approval request as an interactive Feishu card with buttons.

    Requires:
      - Feishu bot token (Lark token with im:message:send scope)
      - Chat ID or open_id of the approver

    The card has two action buttons:
      ✅ Approve  → calls /approval/{id}/approve
      ❌ Deny     → calls /approval/{id}/deny
    """

    def __init__(
        self,
        bot_token: str,
        chat_id: str,
        *,
        approval_server_base: str = "http://127.0.0.1:8080",
        timeout_seconds: int = 300,
    ) -> None:
        self.bot_token = bot_token
        self.chat_id = chat_id
        self.server_base = approval_server_base.rstrip("/")
        self.timeout_seconds = timeout_seconds

    def send_request(self, record: ApprovalRecord) -> bool:
        import urllib.request

        card = {
            "schema": "2.0",
            "body": {
                "elements": [
                    {
                        "tag": "markdown",
                        "content": f"**🛑 安全审批请求**\n\n"
                                   f"**操作:** `{record.action}`\n"
                                   f"**目标:** `{record.subject}`\n\n"
                                   f"**参数:**\n"
                                   f"```json\n{_mask_secrets(record.context)}\n```\n\n"
                                   f"⏱️ 将在 **{self.timeout_seconds}s** 后超时",
                    },
                    {
                        "tag": "action",
                        "actions": [
                            {
                                "tag": "button",
                                "text": {"tag": "plain_text", "content": "✅ 批准"},
                                "type": "primary",
                                "action_id": f"approve:{record.id}",
                                "url": f"{self.server_base}/approval/{record.id}/approve",
                            },
                            {
                                "tag": "button",
                                "text": {"tag": "plain_text", "content": "❌ 拒绝"},
                                "type": "danger",
                                "action_id": f"deny:{record.id}",
                                "url": f"{self.server_base}/approval/{record.id}/deny",
                            },
                        ],
                    },
                ],
            },
            "header": {
                "title": {"tag": "plain_text", "content": "🔒 OpenClaw 安全审批"},
                "template": "orange",
            },
        }

        payload = json.dumps({
            "receive_id": self.chat_id,
            "msg_type": "interactive",
            "content": json.dumps(card, ensure_ascii=False),
        }, ensure_ascii=False).encode()

        req = urllib.request.Request(
            "https://open.feishu.cn/open-apis/im/v1/messages?receive_id_type=chat_id",
            data=payload,
            headers={
                "Authorization": f"Bearer {self.bot_token}",
                "Content-Type": "application/json",
            },
            method="POST",
        )
        try:
            with urllib.request.urlopen(req, timeout=15) as resp:
                result = json.loads(resp.read())
                return result.get("code", 0) == 0
        except Exception as exc:
            logger.error("feishu approval send failed: %s", exc)
            return False

    def send_resolution(self, record: ApprovalRecord, *, approved: bool) -> None:
        import urllib.request

        status_icon = "✅" if approved else "❌"
        status_text = "**已批准**" if approved else "**已拒绝**"
        template = "green" if approved else "red"

        card = {
            "schema": "2.0",
            "body": {
                "elements": [
                    {
                        "tag": "markdown",
                        "content": f"{status_icon} **审批结果:** {status_text}\n\n"
                                   f"**操作:** `{record.action}` / **{record.subject}**\n"
                                   f"**审批人:** {record.resolved_by}\n"
                                   f"**理由:** {record.resolved_reason or '（无）'}",
                    },
                ],
            },
            "header": {
                "title": {"tag": "plain_text", "content": "🔒 OpenClaw 审批结果"},
                "template": template,
            },
        }

        payload = json.dumps({
            "receive_id": self.chat_id,
            "msg_type": "interactive",
            "content": json.dumps(card, ensure_ascii=False),
        }, ensure_ascii=False).encode()

        req = urllib.request.Request(
            "https://open.feishu.cn/open-apis/im/v1/messages?receive_id_type=chat_id",
            data=payload,
            headers={
                "Authorization": f"Bearer {self.bot_token}",
                "Content-Type": "application/json",
            },
            method="POST",
        )
        try:
            with urllib.request.urlopen(req, timeout=15):
                pass
        except Exception as exc:
            logger.warning("feishu resolution notification failed: %s", exc)


# ─────────────────────────────────────────────────────────────────────────────
# Approval Resolution Web Server (Mixin / Standalone)
# ─────────────────────────────────────────────────────────────────────────────

class ApprovalServer:
    """Minimal HTTP server to handle approval resolution callbacks.

    Usage (standalone):
      broker = ApprovalBroker(timeout_seconds=300)
      server = ApprovalServer(broker=broker, host="127.0.0.1", port=8081)
      server.start()

    Usage (with Gateway):
      gateway.approval_broker = broker
      server = ApprovalServer(broker=broker, host="127.0.0.1", port=8081)
      threading.Thread(target=server.serve, daemon=True).start()
    """

    def __init__(
        self,
        broker: ApprovalBroker,
        host: str = "127.0.0.1",
        port: int = 8081,
    ) -> None:
        self.broker = broker
        self.host = host
        self.port = port

    def serve(self) -> None:
        import http.server
        import socketserver

        class _Handler(http.server.BaseHTTPRequestHandler):
            _broker = self.broker  # type: ignore[assignment]

            def do_GET(self) -> None:
                path = self.path.strip("/")
                if path.startswith("approval/"):
                    parts = path.split("/")
                    if len(parts) == 3 and parts[2] in ("approve", "deny"):
                        approval_id = parts[1]
                        approved = parts[2] == "approve"
                        resolved = self._broker.resolve(
                            approval_id,
                            approved=approved,
                            resolved_by="human:webhook",
                            reason="clicked button",
                        )
                        self.send_response(200)
                        self.send_header("Content-Type", "text/html")
                        self.end_headers()
                        msg = "✅ Approved" if approved else "❌ Denied"
                        self.wfile.write(f"<html><body><h1>{msg}</h1><p>Close this tab.</p></body></html>".encode())
                        return
                self.send_response(404)
                self.end_headers()

            def log_message(self, format: str, *args: Any) -> None:
                pass  # suppress noise

        with socketserver.TCPServer((self.host, self.port), _Handler) as srv:
            logger.info("approval server listening on %s:%s", self.host, self.port)
            srv.serve_forever()


# ─────────────────────────────────────────────────────────────────────────────
# Helpers
# ─────────────────────────────────────────────────────────────────────────────

def _future_iso(seconds: int = 300) -> str:
    from datetime import timedelta
    return (datetime.now(timezone.utc) + timedelta(seconds=seconds)).isoformat()


def _mask_secrets(context: dict[str, Any], max_len: int = 200) -> str:
    """Return a JSON string with secret values masked."""
    import json
    secret_keys = {"token", "password", "secret", "key", "auth", "credential", "private"}
    masked = {}
    for k, v in (context or {}).items():
        if any(pat in str(k).lower() for pat in secret_keys):
            masked[k] = "[REDACTED]"
        elif isinstance(v, str) and len(v) > max_len:
            masked[k] = v[:max_len] + "..."
        else:
            masked[k] = v
    return json.dumps(masked, ensure_ascii=False, indent=2, default=str)
