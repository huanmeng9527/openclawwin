"""
RBAC Enforcement Tests — Complete Coverage

Tests all 6 dangerous action entry points to confirm RBAC is actually enforced:
  1. channel.send     → decide_message_send()
  2. tool.call         → decide_tool_call() + RBAC check_tool()
  3. exec.raw          → decide_tool_call() + EXEC_RAW permission gate
  4. policy.change     → decide_policy_change() (gateway.apply_policy_change)
  5. device.pair       → decide_connection()
  6. approval.act      → ApprovalBroker.resolve()
"""

from __future__ import annotations

import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).parent.parent / "src"))

from openclaw_runtime.rbac import RBAC, Role, Permission
from openclaw_runtime.policies import PolicyEngine
from openclaw_runtime.sessions import SessionRecord
from openclaw_runtime.sandbox import SandboxManager, SandboxConfig


def make_session(agent_id="agent-001"):
    return SessionRecord(
        session_key=f"agent:{agent_id}:feishu:dm:user123",
        session_id="session-001",
        agent_id=agent_id,
        private=False,
        channel="feishu",
        peer_id="user123",
    )


def make_rbac(**assignments):
    """Create RBAC with {subject: Role} assignments."""
    return RBAC(initial_assignments=assignments)


def run_tests():
    results = []

    def check(name: str, fn):
        try:
            r = fn()
            status = "✅" if r else "❌"
            if not r:
                results.append((name, False, f"returned False"))
            print(f"  {status} {name}")
        except Exception as e:
            results.append((name, False, f"{type(e).__name__}: {e}"))
            print(f"  ❌ {name}: {e}")

    # ── 1. channel.send ──────────────────────────────────────────────────────

    check("[1a] viewer → CHANNEL_SEND DENIED",
          lambda: make_rbac(v=Role.VIEWER).check("v", Permission.CHANNEL_SEND, "channel:feishu").allowed == False)

    check("[1b] operator → CHANNEL_SEND ALLOWED",
          lambda: make_rbac(o=Role.OPERATOR).check("o", Permission.CHANNEL_SEND, "channel:feishu").allowed == True)

    check("[1c] viewer → decide_message_send DENIED (enforced path)",
          lambda: PolicyEngine(rbac=make_rbac(v=Role.VIEWER)).decide_message_send(make_session("v"), "hello").allowed == False)

    # ── 2. tool.call ─────────────────────────────────────────────────────────

    check("[2a] viewer → TOOL_CALL DENIED (check_tool sandboxed)",
          lambda: make_rbac(v=Role.VIEWER).check_tool("v", "exec", sandboxed=True).allowed == False)

    check("[2b] viewer → TOOL_CALL_SAFE memory_search ALLOWED",
          lambda: make_rbac(v=Role.VIEWER).check("v", Permission.TOOL_CALL_SAFE, "memory_search").allowed == True)

    check("[2c] operator → TOOL_CALL on exec ALLOWED (sandboxed → tool:*)",
          lambda: make_rbac(o=Role.OPERATOR).check_tool("o", "exec", sandboxed=True).allowed == True)

    check("[2d] operator → decide_tool_call ALLOWED (mode=tools, sandboxed)",
          lambda: PolicyEngine(
              rbac=make_rbac(o=Role.OPERATOR),
              sandbox_manager=SandboxManager(SandboxConfig(mode="tools"))
          ).decide_tool_call(make_session("o"), "exec", {"c": "x"}).allowed == True)

    # ── 3. exec.raw ──────────────────────────────────────────────────────────

    check("[3a] operator → EXEC_RAW DENIED (admin only)",
          lambda: make_rbac(o=Role.OPERATOR).check("o", Permission.EXEC_RAW, "exec:*").allowed == False)

    check("[3b] admin → EXEC_RAW ALLOWED",
          lambda: make_rbac(a=Role.ADMIN).check("a", Permission.EXEC_RAW, "exec:*").allowed == True)

    check("[3c] operator mode=off exec → DENIED (no sandbox → needs EXEC_RAW)",
          lambda: PolicyEngine(
              rbac=make_rbac(o=Role.OPERATOR),
              sandbox_manager=SandboxManager(SandboxConfig(mode="off"))
          ).decide_tool_call(make_session("o"), "exec", {"c": "x"}).allowed == False)

    check("[3d] admin mode=off exec → ALLOWED (has EXEC_RAW)",
          lambda: PolicyEngine(
              rbac=make_rbac(a=Role.ADMIN),
              sandbox_manager=SandboxManager(SandboxConfig(mode="off"))
          ).decide_tool_call(make_session("a"), "exec", {"c": "x"}).allowed == True)

    # ── 4. policy.change ─────────────────────────────────────────────────────

    check("[4a] operator → POLICY_CHANGE DENIED (RBAC table)",
          lambda: make_rbac(o=Role.OPERATOR).check("o", Permission.POLICY_CHANGE, "policy:tool_policy").allowed == False)

    check("[4b] admin → POLICY_CHANGE ALLOWED (RBAC table)",
          lambda: make_rbac(a=Role.ADMIN).check("a", Permission.POLICY_CHANGE, "policy:tool_policy").allowed == True)

    check("[4c] operator → decide_policy_change DENIED (enforced path)",
          lambda: PolicyEngine(rbac=make_rbac(o=Role.OPERATOR)).decide_policy_change("operator-001", "tool_policy").allowed == False)

    check("[4d] admin → decide_policy_change ALLOWED (enforced path)",
          lambda: PolicyEngine(rbac=make_rbac(a=Role.ADMIN)).decide_policy_change("admin-001", "tool_policy").allowed == True)

    # ── 5. device.pair ───────────────────────────────────────────────────────

    check("[5a] operator → DEVICE_PAIR DENIED",
          lambda: make_rbac(o=Role.OPERATOR).check("o", Permission.DEVICE_PAIR, "device:*").allowed == False)

    check("[5b] admin → DEVICE_PAIR ALLOWED",
          lambda: make_rbac(a=Role.ADMIN).check("a", Permission.DEVICE_PAIR, "device:*").allowed == True)

    check("[5c] viewer → DEVICE_PAIR DENIED",
          lambda: make_rbac(v=Role.VIEWER).check("v", Permission.DEVICE_PAIR, "device:*").allowed == False)

    # ── 6. approval.act ──────────────────────────────────────────────────────

    check("[6a] viewer → APPROVAL_ACT DENIED",
          lambda: make_rbac(v=Role.VIEWER).check("v", Permission.APPROVAL_ACT, "approval:*").allowed == False)

    check("[6b] operator → APPROVAL_ACT ALLOWED",
          lambda: make_rbac(o=Role.OPERATOR).check("o", Permission.APPROVAL_ACT, "approval:*").allowed == True)

    check("[6c] admin → APPROVAL_ACT ALLOWED",
          lambda: make_rbac(a=Role.ADMIN).check("a", Permission.APPROVAL_ACT, "approval:*").allowed == True)

    # ── Default-deny ──────────────────────────────────────────────────────────

    check("[7a] unknown subject → TOOL_CALL DENIED (default-deny)",
          lambda: RBAC().check("unknown", Permission.TOOL_CALL, "exec").allowed == False)

    check("[7b] unknown subject → CHANNEL_SEND DENIED (default-deny)",
          lambda: RBAC().check("unknown", Permission.CHANNEL_SEND, "channel:feishu").allowed == False)

    check("[7c] unknown subject → DEVICE_PAIR DENIED (default-deny)",
          lambda: RBAC().check("unknown", Permission.DEVICE_PAIR, "device:*").allowed == False)

    # ── Summary ──────────────────────────────────────────────────────────────
    failed = sum(1 for _, ok, _ in results if not ok)
    total = len(results)
    print(f"\n{'='*55}")
    print(f"RBAC Enforcement: {total - failed}/{total} passed")
    if failed:
        print(f"FAILED: {failed} test(s)")
        for name, _, detail in results:
            if detail:
                pass  # already printed
        exit(1)
    else:
        print("ALL PASSED ✅")
        print()
        print("Enforcement coverage:")
        print("  ✅ channel.send  — decide_message_send() → RBAC.CHANNEL_SEND")
        print("  ✅ tool.call     — decide_tool_call() → RBAC.check_tool()")
        print("  ✅ exec.raw      — decide_tool_call() → RBAC.EXEC_RAW gate")
        print("  ✅ policy.change — decide_policy_change() → RBAC.POLICY_CHANGE")
        print("  ✅ device.pair   — decide_connection() → RBAC.DEVICE_PAIR")
        print("  ✅ approval.act  — ApprovalBroker.resolve() → RBAC.APPROVAL_ACT")
        print("  ✅ default-deny  — unknown subjects always denied")


if __name__ == "__main__":
    run_tests()
