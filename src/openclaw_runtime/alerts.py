"""
Security Alert System — SOC-ready alerting for OpenClaw.

Architectural layers:
  AlertManager        — central engine, owns all rules, routes to channels
  AlertRule           — declarative pattern for a specific alert type
  AlertChannel        — ABC for delivery (Feishu / Slack / Webhook / Log)
  FeishuAlertChannel  — real-time Feishu card delivery

Alert evaluation happens at two points:
  1. AuditLogger.log_event()   → real-time rule evaluation
  2. AlertManager.check_cycle() → periodic anomaly detection (frequency/spike)

Usage in gateway.py:
  alerts = AlertManager()
  alerts.register_channel(FeishuAlertChannel(bot_token=..., chat_id=...))
  gateway.alerts = alerts
  gateway.audit_logger.alerts = alerts   # so audit can fire immediate alerts
  gateway.approval_broker.alerts = alerts
"""

from __future__ import annotations

import gzip
import json
import logging
import threading
import time
import urllib.request
from abc import ABC, abstractmethod
from collections import defaultdict, deque
from dataclasses import asdict, dataclass, field
from datetime import datetime, timezone
from enum import Enum
from pathlib import Path
from typing import Any

from .audit import AuditEvent, AuditAction, AuditResult

logger = logging.getLogger(__name__)


# ── Severity & Category ────────────────────────────────────────────────────────

class AlertSeverity(str, Enum):
    CRITICAL = "critical"
    HIGH = "high"
    MEDIUM = "medium"
    LOW = "low"

    def emoji(self) -> str:
        return {"critical": "🔴", "high": "🟠", "medium": "🟡", "low": "🔵"}[self.value]


class AlertCategory(str, Enum):
    RBAC_DENY = "rbac.deny"         # permission denied
    APPROVAL_ANOMALY = "approval"    # approval anomalies
    FREQUENCY_ANOMALY = "frequency"  # rate spike / flood
    AUDIT_SYSTEM = "audit.system"   # audit infrastructure failure


# ── AlertEvent ────────────────────────────────────────────────────────────────

@dataclass(frozen=True)
class AlertEvent:
    """A single fired alert, emitted by AlertManager."""
    id: str = ""                                       # unique alert id
    timestamp: str = field(default_factory=lambda: datetime.now(timezone.utc).isoformat())
    severity: AlertSeverity = AlertSeverity.LOW
    category: AlertCategory = AlertCategory.RBAC_DENY
    title: str = ""                   # short summary
    body: str = ""                     # detailed description
    # What triggered it
    trigger_audit: bool = False   # was it triggered by an audit event?
    audit_event: AuditEvent | None = None
    # Who / what was affected
    subject_id: str = ""
    subject_role: str = ""
    permission: str = ""
    resource: str = ""
    action: str = ""
    # Context
    count: int = 1                # how many events contributed to this alert
    window_seconds: int = 0       # time window for frequency alerts
    extra: dict[str, Any] = field(default_factory=dict)

    def to_dict(self) -> dict[str, Any]:
        d = asdict(self)
        d["severity"] = self.severity.value
        d["category"] = self.category.value
        return d


# ── AlertRule ─────────────────────────────────────────────────────────────────

@dataclass
class AlertRule:
    """Declarative alert rule."""
    name: str
    category: AlertCategory
    severity: AlertSeverity
    # Human-readable title template (use {field} placeholders)
    title_template: str
    body_template: str
    # Evaluation: which audit events match this rule?
    # Return True to fire an alert immediately
    matches_immediate: callable[[AuditEvent], bool] | None = None
    # Periodic check: return True to fire (called with recent events list)
    matches_anomaly: callable[[list[AuditEvent]], bool] | None = None
    # Parameters
    window_seconds: int = 600      # anomaly detection window
    threshold: int = 20            # trigger threshold
    cooldown_seconds: int = 300    # suppress duplicate alerts
    # Track state
    last_fired_at: float = 0.0
    fire_count: int = 0

    def is_in_cooldown(self) -> bool:
        return (time.time() - self.last_fired_at) < self.cooldown_seconds

    def fire(self, alert: AlertEvent) -> None:
        self.last_fired_at = time.time()
        self.fire_count += 1
        logger.warning(
            "ALERT [%s] %s: %s — %s",
            alert.severity.value.upper(),
            alert.category.value,
            alert.title,
            alert.body,
        )


# ── AlertChannel ───────────────────────────────────────────────────────────────

class AlertChannel(ABC):
    """ABC for alert delivery. Implement send()."""

    @abstractmethod
    def send(self, alert: AlertEvent) -> None:
        """Deliver an alert. Failures must be non-fatal."""
        ...

    def send_batch(self, alerts: list[AlertEvent]) -> None:
        for a in alerts:
            try:
                self.send(a)
            except Exception as exc:
                logger.error("alert channel %s send failed: %s", self.__class__.__name__, exc)


# ── Feishu Alert Channel ───────────────────────────────────────────────────────

class FeishuAlertChannel(AlertChannel):
    """Deliver alerts as Feishu interactive cards.

    Requires:
      - Feishu bot token (Lark token with im:message:send scope)
      - Chat ID or open_id to post to
    """

    def __init__(
        self,
        bot_token: str,
        chat_id: str,
        *,
        min_severity: AlertSeverity = AlertSeverity.HIGH,
        mention_ids: list[str] | None = None,  # open_ids to @mention on CRITICAL
    ) -> None:
        self.bot_token = bot_token
        self.chat_id = chat_id
        self.min_severity = min_severity
        self.mention_ids = mention_ids or []

    def send(self, alert: AlertEvent) -> None:
        if alert.severity.value not in [s.value for s in AlertSeverity
                                         if AlertSeverity(alert.severity.value) >= self.min_severity]:
            return  # below minimum severity

        card = self._build_card(alert)
        self._post_card(card)

    def _build_card(self, alert: AlertEvent) -> dict[str, Any]:
        emoji = alert.severity.emoji()
        body_lines = alert.body.split("\n")

        elements = [
            {
                "tag": "markdown",
                "content": (
                    f"**{emoji} [{alert.severity.value.upper()}] {alert.title}**\n\n"
                    f"**分类:** `{alert.category.value}`\n"
                    f"**时间:** `{alert.timestamp}`"
                ),
            },
            {"tag": "hr"},
            {
                "tag": "markdown",
                "content": f"```\n{alert.body}\n```",
            },
        ]

        # Add context fields if available
        context_parts = []
        if alert.subject_id:
            context_parts.append(f"**Subject:** `{alert.subject_id}`")
        if alert.subject_role:
            context_parts.append(f"**Role:** `{alert.subject_role}`")
        if alert.permission:
            context_parts.append(f"**Permission:** `{alert.permission}`")
        if alert.resource:
            context_parts.append(f"**Resource:** `{alert.resource}`")
        if alert.count > 1:
            context_parts.append(f"**触发次数:** {alert.count} 次 / {alert.window_seconds}s")

        if context_parts:
            elements.append({
                "tag": "markdown",
                "content": "\n".join(context_parts),
            })

        # CRITICAL alerts: @mention configured approvers
        if alert.severity == AlertSeverity.CRITICAL and self.mention_ids:
            at_elements = [
                {
                    "tag": "markdown",
                    "content": "**⚠️ 需要立即处理**",
                }
            ]
            for uid in self.mention_ids:
                at_elements.append({
                    "tag": "at",
                    "user_id": uid,
                })
            elements += at_elements

        return {
            "schema": "2.0",
            "body": {"elements": elements},
        }

    def _post_card(self, card: dict[str, Any]) -> None:
        import urllib.request

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
                if result.get("code", 0) != 0:
                    logger.error("feishu alert send failed: code=%s msg=%s",
                                 result.get("code"), result.get("msg"))
                else:
                    logger.debug("feishu alert sent successfully")
        except Exception as exc:
            logger.error("feishu alert send failed: %s", exc)


# ── Log Alert Channel (always-on fallback) ─────────────────────────────────────

class LogAlertChannel(AlertChannel):
    """Always-on fallback: write alerts to a dedicated log file."""

    def __init__(self, log_path: str | Path | None = None) -> None:
        import os
        self.log_path = Path(log_path or os.path.expanduser("~/.openclaw/logs/alerts/alerts.jsonl"))
        self.log_path.parent.mkdir(parents=True, exist_ok=True)
        self._lock = threading.Lock()

    def send(self, alert: AlertEvent) -> None:
        line = json.dumps(alert.to_dict(), ensure_ascii=False) + "\n"
        with self._lock:
            with open(self.log_path, "a", encoding="utf-8") as f:
                f.write(line)


# ── AlertManager ───────────────────────────────────────────────────────────────

class AlertManager:
    """Central alert engine.

    Evaluation points:
      - evaluate_audit(event)   — called by AuditLogger on every log_event()
      - check_cycle()           — called periodically (every 60s) for frequency rules
    """

    def __init__(
        self,
        *,
        check_interval_seconds: float = 60.0,
    ) -> None:
        self._channels: list[AlertChannel] = []
        self._rules: list[AlertRule] = []
        self._lock = threading.RLock()

        # Frequency tracking: subject_id → deque of timestamps
        self._subject_deny_counts: dict[str, deque[float]] = defaultdict(lambda: deque(maxlen=1000))
        self._approval_fail_counts: dict[str, deque[float]] = defaultdict(lambda: deque(maxlen=500))
        self._pending_approval_ids: set[str] = set()
        self._audit_write_failures: deque[float] = deque(maxlen=100)

        self._check_interval = check_interval_seconds
        self._stop_event = threading.Event()
        self._check_thread: threading.Thread | None = None

        # Build default rules
        self._build_default_rules()

    # ── Channel management ───────────────────────────────────────────────────

    def register_channel(self, channel: AlertChannel) -> None:
        with self._lock:
            self._channels.append(channel)

    # ── Rule management ─────────────────────────────────────────────────────

    def add_rule(self, rule: AlertRule) -> None:
        with self._lock:
            self._rules.append(rule)

    def _build_default_rules(self) -> None:
        """Install the standard SOC alert rules."""
        # ── Category 1: High-risk RBAC denials ──────────────────────────────
        self.add_rule(AlertRule(
            name="exec_raw_denied",
            category=AlertCategory.RBAC_DENY,
            severity=AlertSeverity.HIGH,
            title_template="⚠️ exec.raw 权限被拒",
            body_template="主体 {subject_id} (role={subject_role}) 尝试执行 exec.raw 被 RBAC 拒绝。\n"
                         "目标资源: {resource}\n"
                         "这是高风险操作——无沙箱的原始命令执行被拦截。",
            matches_immediate=lambda e: (
                e.decision == AuditResult.DENY
                and e.permission == "exec.raw"
            ),
            cooldown_seconds=60,
        ))

        self.add_rule(AlertRule(
            name="policy_change_denied",
            category=AlertCategory.RBAC_DENY,
            severity=AlertSeverity.CRITICAL,
            title_template="🔴 policy.change 权限被拒",
            body_template="主体 {subject_id} (role={subject_role}) 尝试修改策略 {resource} 被拒绝。\n"
                         "policy.change 是最高危操作之一，仅 ADMIN 应有权限。",
            matches_immediate=lambda e: (
                e.decision == AuditResult.DENY
                and e.permission == "policy.change"
            ),
            cooldown_seconds=300,
        ))

        self.add_rule(AlertRule(
            name="device_pair_denied",
            category=AlertCategory.RBAC_DENY,
            severity=AlertSeverity.HIGH,
            title_template="⚠️ 设备配对权限被拒",
            body_template="主体 {subject_id} (role={subject_role}) 尝试配对设备 {resource} 被拒绝。\n"
                         "未经授权的设备配对可能意味着恶意设备接入。",
            matches_immediate=lambda e: (
                e.decision == AuditResult.DENY
                and e.permission == "device.pair"
            ),
            cooldown_seconds=120,
        ))

        self.add_rule(AlertRule(
            name="approval_act_blocked",
            category=AlertCategory.APPROVAL_ANOMALY,
            severity=AlertSeverity.HIGH,
            title_template="⚠️ 审批权限被拒",
            body_template="主体 {subject_id} 尝试执行审批操作 {permission} 被 RBAC 拒绝。\n"
                         "这可能是横向移动——低权限主体试图提升权限。",
            matches_immediate=lambda e: (
                e.decision == AuditResult.DENY
                and e.permission == "approval.act"
            ),
            cooldown_seconds=60,
        ))

        # ── Category 2: Approval anomalies ────────────────────────────────
        self.add_rule(AlertRule(
            name="approval_unauthorized_attempt",
            category=AlertCategory.APPROVAL_ANOMALY,
            severity=AlertSeverity.MEDIUM,
            title_template="🔍 无权主体尝试审批",
            body_template="无 APPROVAL_ACT 权限的主体 {subject_id} 试图审批 {resource}。\n"
                         "建议检查该主体的操作日志。",
            matches_immediate=lambda e: (
                e.action == AuditAction.APPROVAL_RESOLVE
                and e.decision == AuditResult.DENY
            ),
            cooldown_seconds=60,
        ))

        self.add_rule(AlertRule(
            name="approval_stuck_pending",
            category=AlertCategory.APPROVAL_ANOMALY,
            severity=AlertSeverity.MEDIUM,
            title_template="⏰ 审批请求超时无人处理",
            body_template="动作 {action} 的审批请求已等待超过 {window_seconds}s 但未被处理。\n"
                         "高风险操作长时间等待审批可能影响业务，请确认流程正常。",
            matches_anomaly=lambda recent, *_: self._check_stuck_approvals(recent),
            window_seconds=600,
            threshold=1,
            cooldown_seconds=600,
        ))

        # ── Category 3: Frequency anomalies ──────────────────────────────
        self.add_rule(AlertRule(
            name="subject_deny_flood",
            category=AlertCategory.FREQUENCY_ANOMALY,
            severity=AlertSeverity.HIGH,
            title_template="🚨 主体权限拒绝频发",
            body_template="主体 {subject_id} 在最近 {window_seconds}s 内累计 {count} 次权限被拒。\n"
                         "可能为暴力探测或凭证滥用，建议立即审查该主体行为。",
            matches_anomaly=lambda recent, ws, thresh: self._check_deny_flood(recent, ws, thresh),
            window_seconds=600,
            threshold=20,
            cooldown_seconds=300,
        ))

        self.add_rule(AlertRule(
            name="multi_subject_deny_spike",
            category=AlertCategory.FREQUENCY_ANOMALY,
            severity=AlertSeverity.CRITICAL,
            title_template="🔴 全局权限拒绝异常激增",
            body_template="系统检测到 {count} 次权限拒绝事件发生在最近 {window_seconds}s 内。\n"
                         "多个主体同时遭遇拒绝可能意味着正在遭受系统性探测攻击。",
            matches_anomaly=lambda recent, *_: self._check_global_spike(recent),
            window_seconds=300,
            threshold=50,
            cooldown_seconds=600,
        ))

        # ── Category 4: Audit system self-monitoring ─────────────────────
        self.add_rule(AlertRule(
            name="audit_write_failure",
            category=AlertCategory.AUDIT_SYSTEM,
            severity=AlertSeverity.CRITICAL,
            title_template="🔴 审计日志写入失败",
            body_template="审计日志连续写入失败。\n"
                         "审计系统故障会导致安全事件无法追踪，必须立即处理。\n"
                         "失败次数: {count}",
            matches_anomaly=lambda recent: self._check_audit_failures(recent),
            window_seconds=60,
            threshold=3,
            cooldown_seconds=120,
        ))

        self.add_rule(AlertRule(
            name="audit_compression_failure",
            category=AlertCategory.AUDIT_SYSTEM,
            severity=AlertSeverity.MEDIUM,
            title_template="⚠️ 审计日志压缩失败",
            body_template="审计日志轮转后压缩失败。\n"
                         "可能导致磁盘占用异常或历史日志不可读。",
            matches_immediate=lambda e: (
                e.action == "audit.system"
                and e.error_detail
                and "compress" in e.error_detail.lower()
            ),
            cooldown_seconds=300,
        ))

    # ── Anomaly helpers ─────────────────────────────────────────────────────

    def _check_stuck_approvals(self, recent: list[AuditEvent]) -> bool:
        # Fire if any approval.required events are older than window_seconds
        now = time.time()
        for e in recent:
            if e.approval_required and e.approval_result == "":
                try:
                    ts = datetime.fromisoformat(e.timestamp.replace("Z", "+00:00"))
                    age = now - ts.timestamp()
                    if age > 600:
                        return True
                except Exception:
                    pass
        return False

    def _check_deny_flood(self, recent: list[AuditEvent],
                          window_seconds: int = 600,
                          threshold: int = 20) -> bool:
        deny_counts: dict[str, int] = defaultdict(int)
        now = time.time()
        for e in recent:
            if e.decision == AuditResult.DENY:
                try:
                    ts = datetime.fromisoformat(e.timestamp.replace("Z", "+00:00"))
                    age = now - ts.timestamp()
                    if age <= window_seconds:
                        deny_counts[e.subject_id] += 1
                except Exception:
                    pass
        return any(c >= threshold for c in deny_counts.values())

    def _check_global_spike(self, recent: list[AuditEvent]) -> bool:
        now = time.time()
        count = sum(
            1 for e in recent
            if e.decision == AuditResult.DENY
            and (now - _event_timestamp(e)) < 300
        )
        return count >= 50

    # ── Public evaluation API ───────────────────────────────────────────────

    def evaluate_audit(self, event: AuditEvent) -> None:
        """Called by AuditLogger on every logged event. Evaluates immediate rules."""
        with self._lock:
            for rule in self._rules:
                if rule.is_in_cooldown():
                    continue
                if rule.matches_immediate is not None:
                    try:
                        if rule.matches_immediate(event):
                            alert = self._build_alert(rule, event)
                            rule.fire(alert)
                            self._dispatch(alert)
                    except Exception as exc:
                        logger.error("alert rule %s evaluation error: %s", rule.name, exc)

    def evaluate_approval(self, action: str, subject: str, subject_role: str,
                          approved: bool, denied: bool) -> None:
        """Called by ApprovalBroker on resolve()."""
        with self._lock:
            for rule in self._rules:
                if rule.is_in_cooldown():
                    continue
                if rule.name == "approval_unauthorized_attempt" and denied:
                    alert = AlertEvent(
                        id=f"approval-denied-{subject}-{int(time.time())}",
                        severity=AlertSeverity.MEDIUM,
                        category=AlertCategory.APPROVAL_ANOMALY,
                        title=f"无权主体尝试审批: {subject}",
                        body=f"主体 {subject} (role={subject_role}) 尝试审批 {action} 被拒绝。",
                        subject_id=subject,
                        subject_role=subject_role,
                        action=action,
                    )
                    rule.fire(alert)
                    self._dispatch(alert)

    def record_audit_failure(self) -> None:
        """Called when AuditLogger fails to write."""
        self._audit_write_failures.append(time.time())

    def start_cycle(self) -> None:
        """Start the periodic anomaly check thread."""
        self._stop_event.clear()
        self._check_thread = threading.Thread(target=self._run_cycle, daemon=True)
        self._check_thread.start()
        logger.info("alert manager started (check_interval=%.0fs)", self._check_interval)

    def stop_cycle(self) -> None:
        self._stop_event.set()
        if self._check_thread:
            self._check_thread.join(timeout=5)

    def _run_cycle(self) -> None:
        while not self._stop_event.wait(self._check_interval):
            try:
                self._check_anomalies()
            except Exception as exc:
                logger.error("alert check_cycle error: %s", exc)

    def _check_anomalies(self) -> None:
        """Called every check_interval. Evaluates frequency/anomaly rules."""
        # Gather recent events from all log files
        recent = self._gather_recent_events(window=600)

        with self._lock:
            for rule in self._rules:
                if rule.is_in_cooldown():
                    continue
                if rule.matches_anomaly is not None:
                    try:
                        if rule.matches_anomaly(recent):
                            # Synthesize an AlertEvent for anomaly rules
                            alert = self._build_anomaly_alert(rule, recent)
                            rule.fire(alert)
                            self._dispatch(alert)
                    except Exception as exc:
                        logger.error("alert rule %s anomaly evaluation error: %s", rule.name, exc)

    def _gather_recent_events(self, window: int) -> list[AuditEvent]:
        """Read recent audit events (last 'window' seconds) from current log."""
        events: list[AuditEvent] = []
        try:
            audit_dir = Path("~/.openclaw/audit").expanduser()
            log_path = audit_dir / "audit.jsonl"
            if not log_path.exists():
                return []
            cutoff = time.time() - window
            with open(log_path) as f:
                for line in f:
                    line = line.strip()
                    if not line:
                        continue
                    try:
                        obj = json.loads(line)
                        ts = datetime.fromisoformat(obj.get("timestamp", "").replace("Z", "+00:00"))
                        if ts.timestamp() >= cutoff:
                            events.append(self._obj_to_event(obj))
                    except Exception:
                        continue
        except Exception as exc:
            logger.error("failed to gather recent audit events: %s", exc)
        return events

    def _obj_to_event(self, obj: dict[str, Any]) -> AuditEvent:
        from .audit import AuditAction as AA
        return AuditEvent(
            action=AA(obj.get("action", "")),
            subject_type=obj.get("subject_type", "unknown"),
            subject_id=obj.get("subject_id", ""),
            session_key=obj.get("session_key", ""),
            agent_id=obj.get("agent_id", ""),
            run_id=obj.get("run_id", ""),
            target=obj.get("target", ""),
            args_summary=obj.get("args_summary", {}),
            decision=AuditResult(obj.get("decision", "deny")),
            decision_reason=obj.get("decision_reason", ""),
            approval_required=obj.get("approval_required", False),
            approver=obj.get("approver", ""),
            approval_result=obj.get("approval_result", ""),
            success=obj.get("success", True),
            error_detail=obj.get("error_detail", ""),
            timestamp=obj.get("timestamp", ""),
            subject_role=obj.get("subject_role", ""),
            permission=obj.get("permission", ""),
            resource=obj.get("resource", ""),
        )

    def _build_alert(self, rule: AlertRule, event: AuditEvent) -> AlertEvent:
        return AlertEvent(
            id=f"{rule.name}-{int(time.time())}",
            severity=rule.severity,
            category=rule.category,
            title=self._format_template(rule.title_template, event),
            body=self._format_template(rule.body_template, event),
            trigger_audit=True,
            audit_event=event,
            subject_id=event.subject_id,
            subject_role=event.subject_role,
            permission=event.permission,
            resource=event.resource,
            action=event.action.value if hasattr(event.action, "value") else str(event.action),
        )

    def _build_anomaly_alert(self, rule: AlertRule, recent: list[AuditEvent]) -> AlertEvent:
        deny_count = sum(1 for e in recent if e.decision == AuditResult.DENY)
        subject_counts: dict[str, int] = defaultdict(int)
        for e in recent:
            if e.decision == AuditResult.DENY:
                subject_counts[e.subject_id] += 1
        top_subject = max(subject_counts, key=subject_counts.get, default="unknown")

        return AlertEvent(
            id=f"{rule.name}-{int(time.time())}",
            severity=rule.severity,
            category=rule.category,
            title=self._format_anomaly_title(rule, deny_count),
            body=self._format_anomaly_body(rule, deny_count, top_subject, subject_counts.get(top_subject, 0)),
            trigger_audit=False,
            count=deny_count,
            window_seconds=rule.window_seconds,
            subject_id=top_subject,
        )

    def _format_template(self, template: str, event: AuditEvent) -> str:
        return template.format(
            subject_id=event.subject_id or "(unknown)",
            subject_role=event.subject_role or "(none)",
            permission=event.permission or "(none)",
            resource=event.resource or "(none)",
            action=event.action.value if hasattr(event.action, "value") else str(event.action),
            count=getattr(event, "count", 1),
            window_seconds=getattr(event, "window_seconds", 0),
        )

    def _format_anomaly_title(self, rule: AlertRule, count: int) -> str:
        return rule.title_template.format(
            count=count,
            window_seconds=rule.window_seconds,
            subject_id="",
            resource="",
            permission="",
            action="",
        )

    def _format_anomaly_body(self, rule: AlertRule, count: int, top_subject: str, top_count: int) -> str:
        body = rule.body_template.format(
            count=count,
            window_seconds=rule.window_seconds,
            subject_id=top_subject,
            resource="",
            permission="",
            action="",
        )
        if top_count and top_subject != "unknown":
            body += f"\n最高频率主体: `{top_subject}` × {top_count} 次"
        return body

    def _dispatch(self, alert: AlertEvent) -> None:
        for ch in self._channels:
            try:
                ch.send(alert)
            except Exception as exc:
                logger.error("alert channel %s dispatch failed: %s", ch.__class__.__name__, exc)


# ── Helper ─────────────────────────────────────────────────────────────────────

def _event_timestamp(e: AuditEvent) -> float:
    try:
        return datetime.fromisoformat(e.timestamp.replace("Z", "+00:00")).timestamp()
    except Exception:
        return 0.0
