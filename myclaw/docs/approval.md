# Approval Lifecycle

MyClaw includes a minimal `ApprovalBroker` for confirmation-required operations. It is intentionally headless: there is no Web UI, daemon, bridge, or approval broker service in this step.

Approval requests are persisted as atomic JSON at `$MYCLAW_HOME/approvals/approvals.json` so a later CLI command can inspect or decide them. Corrupt JSON is backed up as `approvals.json.corrupt.<timestamp>` and the broker safely starts with an empty request set.

## Lifecycle

1. `canUseTool()` detects a tool policy of `ask`, a permission rule with `ask`, or a destructive tool call.
2. `StreamingToolExecutor` does not execute the tool.
3. The executor submits an `ApprovalRequest` to `ApprovalBroker`.
4. The tool result returns a structured pending/denied response with `approvalId`, `status`, and `reason`.
5. A caller with approval permission can approve or deny the request.
6. A later tool call may include the approved `approvalId`; policy, permission rules, workspace sandbox, and tool validation still run.

Default mode is `manual`, which creates a pending request and does not execute. `deny` can be used for explicit headless denial. `auto_for_tests` exists only for tests and must not be used as a production default.

## Approval Request Fields

`ApprovalRequest` records:

- `id`
- `type`
- `subject`
- `action`
- `resource`
- `riskLevel`
- `reason`
- `payloadSummary`
- `sessionId`
- `userId`
- `agentId`
- `toolName`
- `createdAt`
- `expiresAt`
- `status`
- `decision`
- `decidedBy`
- `decidedAt`

## Decision Permissions

Approving or denying a request requires explicit permissions:

- `tool_call`: `approval.tool.call`, `policy.change`, or `approval.admin`
- `memory_write`: `approval.memory.write`, `memory.write`, `policy.change`, or `approval.admin`
- `policy_change`: `policy.change` or `approval.admin`
- `system_action`: `approval.system.action`, `policy.change`, or `approval.admin`

Ordinary runtime context does not approve its own high-risk tool calls.

## Audit Events

When a broker has a `SessionTranscriptRecorder`, approval lifecycle events are written to L2 as `system_event` records:

- `approval.submitted`
- `approval.approved`
- `approval.denied`
- `approval.expired`

These events go through the recorder and `MemoryRouter`; they do not bypass memory policy/storage.

## Boundaries

Approval is not a sandbox. It does not replace:

- `ToolPolicy`
- `PermissionRules`
- workspace path sandbox
- memory policy
- future OS/Docker sandboxing

Procedural memory can suggest safe workflows, but it cannot approve or authorize tools.

See `docs/cli.md` for `myclaw approvals list/show/approve/deny` examples.
