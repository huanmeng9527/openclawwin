"""
Structured Security Audit Logger for OpenClaw.

Writes machine-readable JSON Lines (JSONL) to a dedicated audit log file.
Each line is one audit event. Log rotation is handled automatically.

Audit events cover:
  - Policy decisions (tool call, message send, connection)
  - Approval requests and resolutions
  - Session creation / transcript appends
  - Sandbox planning
  - Tool call success / validation failure / runtime errors

The log is NOT part of the agent transcript — it is append-only and
structured specifically for security review and incident forensics.
"""

from __future__ import annotations

import gzip
import hashlib
import json
import logging
import os
import sys
from dataclasses import asdict, dataclass, field
from datetime import datetime, timezone
from enum import Enum
from pathlib import Path
from typing import Any

logger = logging.getLogger(__name__)


class AuditAction(str, Enum):
    CONNECTION = "connection"
    CHANNEL_RECEIVE = "channel.receive"
    TOOL_CALL = "tool.call"
    MESSAGE_SEND = "message.send"
    SANDBOX_PLAN = "sandbox.plan"
    APPROVAL_REQUEST = "approval.request"
    APPROVAL_RESOLVE = "approval.resolve"
    SESSION_CREATE = "session.create"
    TRANSCRIPT_APPEND = "transcript.append"
    ERROR = "error"


class AuditResult(str, Enum):
    ALLOW = "allow"
    DENY = "deny"
    REQUIRE_APPROVAL = "require_approval"
    APPROVED = "approved"
    DENIED = "denied"
    AUTO_APPROVED = "auto_approved"
    ERROR = "error"
    SUCCESS = "success"


@dataclass(frozen=True)
class AuditEvent:
    """Single structured audit log entry for security auditing and forensics."""

    # ── Identification ────────────────────────────────────────────────────
    version: str = "2"  # bumped for new RBAC fields
    timestamp: str = field(default_factory=lambda: datetime.now(timezone.utc).isoformat())

    # Who initiated the action
    subject_type: str = "unknown"  # "device" | "agent" | "system" | "user"
    subject_id: str = "unknown"

    # RBAC role of the subject at time of decision
    subject_role: str = ""  # "viewer" | "operator" | "admin" | ""

    # What permission was checked
    permission: str = ""  # "tool.call" | "channel.send" | etc.

    # What resource was targeted
    resource: str = ""  # "tool:exec" | "channel:feishu" | etc.

    # Context
    session_key: str = ""
    agent_id: str = ""
    run_id: str = ""

    # What action
    action: AuditAction = AuditAction.ERROR
    target: str = ""  # tool name, channel name, etc.

    # Argument summary (never full args — redact sensitive values)
    args_summary: dict[str, Any] = field(default_factory=dict)

    # Policy / RBAC decision
    decision: AuditResult = AuditResult.ALLOW
    decision_reason: str = ""

    # Approval chain
    approval_required: bool = False
    approver: str = ""  # "auto" | "human:name" | "device_id" | ""
    approval_result: str = ""  # "approved" | "denied" | "timeout" | ""

    # Outcome
    success: bool = True
    error_detail: str = ""

    # Performance
    duration_ms: int = 0

    # Extra context
    metadata: dict[str, Any] = field(default_factory=dict)

    def to_json_line(self) -> str:
        return json.dumps(
            asdict(self),
            ensure_ascii=False,
            sort_keys=False,  # keep field order predictable
            default=str,
        )


def _redact_args(args: dict[str, Any], max_len: int = 128) -> dict[str, Any]:
    """Produce a safe argument summary for logging.

    Truncates string values and replaces non-string scalars.
    Removes keys that look like secrets (token, password, key, secret).
    """
    secret_patterns = {"token", "password", "secret", "key", "auth", "credential", "private"}
    summary: dict[str, Any] = {}
    for k, v in (args or {}).items():
        if any(pat in k.lower() for pat in secret_patterns):
            summary[k] = "[REDACTED]"
        elif isinstance(v, str):
            summary[k] = v[:max_len] + ("..." if len(v) > max_len else "")
        else:
            summary[k] = repr(v)[:max_len]
    return summary


class AuditLogger:
    """Append-only structured audit log writer with rotation.

    Writes JSON Lines to a dedicated file (default: workspace/.openclaw/audit/audit.log).
    When the file exceeds max_bytes it rotates: current → .1 → .2 → ... → .max_files.
    Old rotated files are gzip-compressed.
    """

    def __init__(
        self,
        workspace: Path | str,
        *,
        filename: str = "audit.log",
        max_bytes: int = 10 * 1024 * 1024,  # 10 MB per file
        max_files: int = 9,  # keep .1 … .9
        compress_rotated: bool = True,
    ) -> None:
        self.workspace = Path(workspace)
        self.audit_dir = self.workspace / ".openclaw" / "audit"
        self.log_path = self.audit_dir / filename
        self.max_bytes = max_bytes
        self.max_files = max_files
        self.compress_rotated = compress_rotated
        self._file = self._open()

    def _open(self) -> Any:
        self.audit_dir.mkdir(parents=True, exist_ok=True)
        return open(self.log_path, "a", encoding="utf-8")

    def log(self, event: AuditEvent) -> None:
        """Append one audit event. Thread-safe via file lock."""
        try:
            self._file.write(event.to_json_line() + "\n")
            self._file.flush()
            # Check rotation after every write
            self._maybe_rotate()
        except Exception as exc:
            logger.error("audit log write failed: %s", exc, exc_info=True)

    def _maybe_rotate(self) -> None:
        path = self.log_path
        if path.stat().st_size < self.max_bytes:
            return

        self._file.close()

        # Cycle: .log → .log.1.gz → .log.2.gz → ...
        for i in range(self.max_files - 1, 0, -1):
            src = Path(f"{path}.{i}")
            if src.exists():
                dst = Path(f"{path}.{i + 1}")
                if self.compress_rotated:
                    with src.open("rb") as f_in, gzip.open(dst.with_suffix(".gz"), "wb") as f_out:
                        f_out.write(src.read_bytes())
                else:
                    src.rename(dst)
                src.unlink(missing_ok=True)

        # Rename current to .1
        first = Path(f"{path}.1")
        if self.compress_rotated:
            with path.open("rb") as f_in, gzip.open(first.with_suffix(".gz"), "wb") as f_out:
                f_out.write(path.read_bytes())
        else:
            path.rename(first)
        path.touch()

        self._file = self._open()

    def log_event(
        self,
        *,
        action: AuditAction,
        subject_type: str = "unknown",
        subject_id: str = "unknown",
        subject_role: str = "",
        permission: str = "",
        resource: str = "",
        session_key: str = "",
        agent_id: str = "",
        run_id: str = "",
        target: str = "",
        args: dict[str, Any] | None = None,
        decision: AuditResult = AuditResult.ALLOW,
        decision_reason: str = "",
        approval_required: bool = False,
        approver: str = "",
        approval_result: str = "",
        success: bool = True,
        error_detail: str = "",
        duration_ms: int = 0,
        **metadata: Any,
    ) -> None:
        """Construct and write an AuditEvent with full RBAC context."""
        event = AuditEvent(
            subject_type=subject_type,
            subject_id=subject_id,
            subject_role=subject_role,
            permission=permission,
            resource=resource,
            session_key=session_key,
            agent_id=agent_id,
            run_id=run_id,
            action=action,
            target=target,
            args_summary=_redact_args(args or {}),
            decision=decision,
            decision_reason=decision_reason,
            approval_required=approval_required,
            approver=approver,
            approval_result=approval_result,
            success=success,
            error_detail=error_detail,
            duration_ms=duration_ms,
            metadata=metadata,
        )
        self.log(event)

    def close(self) -> None:
        self._file.close()

    def __enter__(self) -> "AuditLogger":
        return self

    def __exit__(self, *args: Any) -> None:
        self.close()


# ── Global accessor ─────────────────────────────────────────────────────────────
# Modules that need to emit audit events receive an AuditLogger instance
# via dependency injection.  There is no global singleton by design — this
# makes testing easier and keeps the audit trail explicit rather than implicit.


# ── Query utility ────────────────────────────────────────────────────────────

    def query(
        self,
        action: AuditAction | str | None = None,
        subject_id: str | None = None,
        subject_role: str | None = None,
        permission: str | None = None,
        resource: str | None = None,
        decision: AuditResult | str | None = None,
        limit: int = 100,
    ) -> list[AuditEvent]:
        """Query audit log with filters. Returns matching events in reverse-chronological order."""
        import fnmatch

        events: list[AuditEvent] = []
        decision_str = decision.value if isinstance(decision, AuditResult) else decision

        # Read current log file + all rotated .gz files
        log_files = []
        audit_dir = Path(self.log_path).parent
        pattern = Path(self.log_path).name

        # Current file
        p = Path(self.log_path)
        if p.exists():
            log_files.append((p, None))
        # Rotated files
        for i in range(1, self.max_files + 1):
            for suffix in [f".{i}", f".{i}.gz"]:
                rp = Path(f"{p}{suffix}")
                if rp.exists():
                    log_files.append((rp, suffix))

        for path, suffix in log_files:
            try:
                if suffix == ".gz" or (suffix is None and str(path).endswith(".gz")):
                    import gzip
                    opener = gzip.open  # "rt" is default mode for gzip.open
                else:
                    opener = open

                with opener(path) as fh:
                    for line in fh:
                        line = line.strip()
                        if not line:
                            continue
                        try:
                            import json
                            obj = json.loads(line)
                            ev = AuditEvent(
                                action=AuditAction(obj.get("action", "")),
                                subject_type=obj.get("subject_type", "unknown"),
                                subject_id=obj.get("subject_id", ""),
                                session_key=obj.get("session_key", ""),
                                agent_id=obj.get("agent_id", ""),
                                run_id=obj.get("run_id", ""),
                                target=obj.get("target", ""),
                                args_summary=obj.get("args", {}),
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
                        except Exception:
                            continue

                        # Apply filters
                        if action is not None and ev.action != action:
                            continue
                        if subject_id is not None and not fnmatch.fnmatch(ev.subject_id, subject_id):
                            continue
                        if subject_role is not None and not fnmatch.fnmatch(ev.subject_role or "", subject_role):
                            continue
                        if permission is not None and not fnmatch.fnmatch(ev.permission or "", permission):
                            continue
                        if resource is not None and not fnmatch.fnmatch(ev.resource or "", resource):
                            continue
                        if decision_str is not None and ev.decision.value != decision_str:
                            continue

                        events.append(ev)
                        if len(events) >= limit:
                            return events
            except Exception:
                continue

        return events
