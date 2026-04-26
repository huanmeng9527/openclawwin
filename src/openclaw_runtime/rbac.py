"""
Role-Based Access Control (RBAC) for OpenClaw.

Provides a complete role → permission → resource → action mapping.

Default roles:
  viewer  — read-only. Can receive messages and read memory. Cannot send,
            execute tools, or modify anything.
  operator — day-to-day operator. Can send messages, call safe tools,
             approve low-risk actions. Cannot change policies or manage devices.
  admin   — full access. Can manage policies, pair devices, approve any action.

Permission model:
  - Default-deny: anything not explicitly allowed is denied.
  - Roles are additive within a device (one device can have one role).
  - Resources are: tool:* , channel:* , memory:*, node:*, policy:*, device:*

Usage:
    from openclaw_runtime.rbac import RBAC, Role, Permission, Resource

    rbac = RBAC()
    rbac.assign_role("device-001", Role.OPERATOR)

    decision = rbac.check(
        subject="device-001",
        permission=Permission.TOOL_CALL,
        resource="exec",
    )
    if not decision.allowed:
        raise PermissionError(decision.reason)
"""

from __future__ import annotations

import re
from dataclasses import dataclass, field
from enum import Enum, Flag, auto


# ─────────────────────────────────────────────────────────────────────────────
# Core Enums
# ─────────────────────────────────────────────────────────────────────────────

class Role(str, Enum):
    """Predefined roles. Add new roles as needed."""

    VIEWER = "viewer"
    OPERATOR = "operator"
    ADMIN = "admin"


class Permission(str, Enum):
    """Fine-grained permissions."""

    # Tools
    TOOL_CALL = "tool.call"           # invoke any tool
    TOOL_CALL_SAFE = "tool.call.safe"  # call only safe-listed tools
    TOOL_REGISTER = "tool.register"   # register new tools

    # Channels / messaging
    CHANNEL_SEND = "channel.send"     # send to a channel
    CHANNEL_RECEIVE = "channel.receive"  # receive from a channel
    CHANNEL_LIST = "channel.list"     # list available channels

    # Memory
    MEMORY_READ = "memory.read"
    MEMORY_WRITE = "memory.write"
    MEMORY_DELETE = "memory.delete"

    # Nodes
    NODE_ACCESS = "node.access"      # access a specific node
    NODE_REGISTER = "node.register"   # register new nodes

    # Policy
    POLICY_VIEW = "policy.view"
    POLICY_CHANGE = "policy.change"  # modify policies (dangerous)

    # Device management
    DEVICE_PAIR = "device.pair"       # pair new devices
    DEVICE_REVOKE = "device.revoke"   # revoke device trust
    DEVICE_LIST = "device.list"       # list paired devices

    # Approval
    APPROVAL_ACT = "approval.act"     # approve/deny pending approvals

    # Gateway
    GATEWAY_CONFIG_VIEW = "gateway.config.view"
    GATEWAY_CONFIG_CHANGE = "gateway.config.change"

    # Execution (high risk)
    EXEC_SANDBOXED = "exec.sandboxed"  # run sandboxed commands
    EXEC_RAW = "exec.raw"              # run raw commands (admin only)


class Resource(str, Enum):
    """Resource categories."""

    TOOL = "tool"
    CHANNEL = "channel"
    MEMORY = "memory"
    NODE = "node"
    POLICY = "policy"
    DEVICE = "device"
    APPROVAL = "approval"
    GATEWAY = "gateway"
    EXEC = "exec"
    ALL = "*"


# ─────────────────────────────────────────────────────────────────────────────
# Role → Permission mapping
# ─────────────────────────────────────────────────────────────────────────────

# Format: (role, permission, resource_pattern, description)
#
# resource_pattern uses fnmatch-style wildcards:
#   "exec"          → matches exactly "exec"
#   "tool:*"        → matches all tools
#   "channel:feishu" → matches channel:feishu
#   "channel:*"     → matches all channels
#   "*"             → matches everything (super-admin)

_DEFAULT_ROLE_TABLE: list[tuple[Role, Permission, str]] = [
    # ── VIEWER ────────────────────────────────────────────────────────────
    (Role.VIEWER, Permission.CHANNEL_RECEIVE, "channel:*",    "receive on any channel"),
    (Role.VIEWER, Permission.CHANNEL_LIST,     "channel:*",    "list channels"),
    (Role.VIEWER, Permission.MEMORY_READ,      "memory:*",     "read memory"),
    (Role.VIEWER, Permission.NODE_ACCESS,       "node:*",       "read node info"),
    (Role.VIEWER, Permission.POLICY_VIEW,      "policy:*",     "view policies"),
    (Role.VIEWER, Permission.GATEWAY_CONFIG_VIEW, "gateway:*", "view gateway config"),
    (Role.VIEWER, Permission.TOOL_CALL_SAFE,    "memory_search", "search memory"),
    (Role.VIEWER, Permission.TOOL_CALL_SAFE,    "memory_get",   "get memory results"),

    # ── OPERATOR ───────────────────────────────────────────────────────────
    (Role.OPERATOR, Permission.CHANNEL_SEND,    "channel:*",    "send on any channel"),
    (Role.OPERATOR, Permission.CHANNEL_RECEIVE,  "channel:*",    "receive on any channel"),
    (Role.OPERATOR, Permission.CHANNEL_LIST,     "channel:*",    "list channels"),
    (Role.OPERATOR, Permission.MEMORY_READ,      "memory:*",     "read memory"),
    (Role.OPERATOR, Permission.MEMORY_WRITE,     "memory:*",     "write to memory"),
    (Role.OPERATOR, Permission.NODE_ACCESS,       "node:*",       "access nodes"),
    (Role.OPERATOR, Permission.POLICY_VIEW,      "policy:*",     "view policies"),
    (Role.OPERATOR, Permission.TOOL_CALL,         "tool:*",       "call any tool"),
    (Role.OPERATOR, Permission.TOOL_REGISTER,     "tool:*",       "register tools"),
    (Role.OPERATOR, Permission.APPROVAL_ACT,     "approval:*",   "approve/deny pending approvals"),
    (Role.OPERATOR, Permission.GATEWAY_CONFIG_VIEW, "gateway:*", "view gateway config"),
    (Role.OPERATOR, Permission.EXEC_SANDBOXED,    "exec:*",       "run sandboxed commands"),

    # ── ADMIN ─────────────────────────────────────────────────────────────
    (Role.ADMIN, Permission.TOOL_CALL,          "tool:*",       "call any tool"),
    (Role.ADMIN, Permission.TOOL_REGISTER,      "tool:*",       "register any tool"),
    (Role.ADMIN, Permission.CHANNEL_SEND,       "channel:*",    "send on any channel"),
    (Role.ADMIN, Permission.CHANNEL_RECEIVE,     "channel:*",    "receive on any channel"),
    (Role.ADMIN, Permission.CHANNEL_LIST,        "channel:*",    "list channels"),
    (Role.ADMIN, Permission.MEMORY_READ,        "memory:*",     "read memory"),
    (Role.ADMIN, Permission.MEMORY_WRITE,        "memory:*",     "write memory"),
    (Role.ADMIN, Permission.MEMORY_DELETE,      "memory:*",     "delete memory"),
    (Role.ADMIN, Permission.NODE_ACCESS,         "node:*",       "access any node"),
    (Role.ADMIN, Permission.NODE_REGISTER,      "node:*",       "register nodes"),
    (Role.ADMIN, Permission.POLICY_VIEW,         "policy:*",     "view policies"),
    (Role.ADMIN, Permission.POLICY_CHANGE,       "policy:*",     "change policies"),
    (Role.ADMIN, Permission.DEVICE_PAIR,        "device:*",     "pair new devices"),
    (Role.ADMIN, Permission.DEVICE_REVOKE,       "device:*",     "revoke devices"),
    (Role.ADMIN, Permission.DEVICE_LIST,          "device:*",     "list devices"),
    (Role.ADMIN, Permission.APPROVAL_ACT,        "approval:*",   "approve/deny any"),
    (Role.ADMIN, Permission.GATEWAY_CONFIG_VIEW, "gateway:*",    "view gateway config"),
    (Role.ADMIN, Permission.GATEWAY_CONFIG_CHANGE, "gateway:*",  "change gateway config"),
    (Role.ADMIN, Permission.EXEC_SANDBOXED,       "exec:*",      "run sandboxed commands"),
    (Role.ADMIN, Permission.EXEC_RAW,              "exec:*",      "run raw commands (no sandbox)"),
]


# ─────────────────────────────────────────────────────────────────────────────
# RBAC Decision
# ─────────────────────────────────────────────────────────────────────────────

@dataclass(frozen=True)
class RBACDecision:
    allowed: bool
    reason: str
    role: Role | None = None
    permission: Permission | None = None
    resource: str = ""


# ─────────────────────────────────────────────────────────────────────────────
# RBAC Engine
# ─────────────────────────────────────────────────────────────────────────────

class RBAC:
    """Role-Based Access Control engine.

    Check permissions with: rbac.check(subject, permission, resource)
    Assign roles with:     rbac.assign_role(subject, role)

    Default-deny: if no rule explicitly allows, the request is denied.
    """

    def __init__(
        self,
        initial_assignments: dict[str, Role] | None = None,
        custom_rules: list[tuple[Role, Permission, str]] | None = None,
    ) -> None:
        # subject_id → Role
        self._role_map: dict[str, Role] = {}

        # (role, permission, resource_pattern) → True
        self._rules: set[tuple[Role, Permission, str]] = set()

        for role, perm, resource, _desc in _DEFAULT_ROLE_TABLE:
            self._rules.add((role, perm, resource))

        if custom_rules:
            for role, perm, resource in custom_rules:
                self._rules.add((role, perm, resource))

        if initial_assignments:
            for subject, role in initial_assignments.items():
                self.assign_role(subject, role)

    def assign_role(self, subject: str, role: Role) -> None:
        """Assign a role to a subject (device, agent, user, etc.)."""
        old = self._role_map.get(subject)
        self._role_map[subject] = role
        if old is not None:
            import logging
            logging.getLogger(__name__).info(
                "role changed: subject=%s %s → %s", subject, old.value, role.value
            )

    def get_role(self, subject: str) -> Role | None:
        """Return the role assigned to a subject, or None if unassigned."""
        return self._role_map.get(subject)

    def revoke_role(self, subject: str) -> None:
        """Remove role assignment from a subject."""
        self._role_map.pop(subject, None)

    def check(
        self,
        subject: str,
        permission: Permission,
        resource: str,
    ) -> RBACDecision:
        """Check if a subject has permission to access a resource.

        Always returns a RBACDecision (never raises).
        Default-deny: if no matching allow rule, request is denied.
        """
        role = self._role_map.get(subject)
        if role is None:
            return RBACDecision(
                allowed=False,
                reason=f"subject '{subject}' has no assigned role (default-deny)",
                role=None,
                permission=permission,
                resource=resource,
            )

        if self._has_permission(role, permission, resource):
            return RBACDecision(
                allowed=True,
                reason=f"role '{role.value}' allows {permission.value} on '{resource}'",
                role=role,
                permission=permission,
                resource=resource,
            )

        return RBACDecision(
            allowed=False,
            reason=f"role '{role.value}' does not grant {permission.value} on '{resource}' "
                   f"(default-deny — no matching rule)",
            role=role,
            permission=permission,
            resource=resource,
        )

    def check_tool(
        self,
        subject: str,
        tool_name: str,
        sandboxed: bool = False,
    ) -> RBACDecision:
        """Convenience: check if subject can call a specific tool.

        Treats safe tools differently for OPERATOR (uses TOOL_CALL_SAFE).
        Admin always gets TOOL_CALL.
        """
        role = self._role_map.get(subject)
        if role is None:
            return self.check(subject, Permission.TOOL_CALL, f"tool:{tool_name}")

        # Determine which permission to check
        perm = Permission.TOOL_CALL_SAFE if not sandboxed else Permission.TOOL_CALL

        if role == Role.ADMIN:
            return self.check(subject, Permission.TOOL_CALL, f"tool:{tool_name}")

        if role == Role.OPERATOR:
            # OPERATOR: TOOL_CALL_SAFE for non-sandboxed, TOOL_CALL for sandboxed
            effective_perm = Permission.TOOL_CALL if sandboxed else Permission.TOOL_CALL_SAFE
            return self.check(subject, effective_perm, f"tool:{tool_name}")

        # VIEWER: only safe tools
        return self.check(subject, Permission.TOOL_CALL_SAFE, f"tool:{tool_name}")

    def _has_permission(self, role: Role, permission: Permission, resource: str) -> bool:
        """Check if (role, permission, resource) matches any rule."""
        for rule_role, rule_perm, rule_res in self._rules:
            if rule_role != role:
                continue
            # Permission must match: exact, or rule is a wildcard
            if rule_perm != permission and rule_perm.value != "*":
                # TOOL_CALL_SAFE also satisfies TOOL_CALL request
                if not (rule_perm == Permission.TOOL_CALL_SAFE and permission == Permission.TOOL_CALL):
                    continue
            # Resource pattern must match
            if _pattern_matches(rule_res, resource):
                return True
        return False

    def allowed_actions(
        self,
        subject: str,
        permission: Permission,
    ) -> list[str]:
        """Return all resources the subject can access with this permission."""
        role = self._role_map.get(subject)
        if role is None:
            return []
        resources: list[str] = []
        for rule_role, rule_perm, rule_res in self._rules:
            if rule_role == role and (
                rule_perm == permission
                or rule_perm.value == "*"
                or _pattern_matches(rule_perm.value, permission.value)
            ):
                if rule_res != "*":
                    resources.append(rule_res)
                else:
                    resources.append("*")
        return sorted(set(resources))


def _pattern_matches(pattern: str, value: str) -> bool:
    """fnmatch-style matching: foo*, *, foo:bar."""
    if pattern == "*":
        return True
    # "tool:*" matches "tool:exec", "tool:memory_search" etc.
    if pattern.endswith("*"):
        prefix = pattern[:-1]  # "tool:" matches "tool:exec"
        return value.startswith(prefix)
    return pattern == value


# ─────────────────────────────────────────────────────────────────────────────
# Integration helpers for PolicyEngine
# ─────────────────────────────────────────────────────────────────────────────

def rbac_decision_to_policy_reason(rbac_decision: RBACDecision) -> str:
    return rbac_decision.reason


def rbac_check(
    rbac: RBAC,
    subject: str,
    permission: Permission,
    resource: str,
) -> bool:
    """Shorthand: return just the bool from an RBAC check."""
    return rbac.check(subject, permission, resource).allowed
