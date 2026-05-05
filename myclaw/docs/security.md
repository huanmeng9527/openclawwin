# Security Notes

MyClaw includes a basic workspace sandbox for local file and command tools. This is a guardrail, not a production isolation boundary.

## Workspace Sandbox

By default, local tools can only operate inside `config.agent.workspace`:

- `read` reads files or directories inside the workspace.
- `write` creates or overwrites files inside the workspace.
- `edit` modifies files inside the workspace.
- `list_files` lists directories inside the workspace.
- `grep` and `glob` search inside the workspace.
- `exec` runs with `cwd` set to the workspace by default.

Relative paths are resolved against `config.agent.workspace`. Absolute paths are allowed only if they are still inside the workspace. Path traversal such as `../outside.txt` is rejected.

The sandbox also rejects symlink escapes by default: a path inside the workspace that resolves outside the workspace is denied.

## External Paths

Set `tools.allowExternalPaths: true` only for trusted local use:

```json
{
  "tools": {
    "allowExternalPaths": true
  }
}
```

This allows file tools and `exec.cwd` to target paths outside `agent.workspace`, but it does not bypass `ToolPolicy`, `PermissionRules`, or tool-specific checks. A denied tool remains denied.

## Exec Policy

`exec` is constrained in three ways:

- `cwd` defaults to `agent.workspace`.
- `cwd` must stay inside the workspace unless `tools.allowExternalPaths` is enabled.
- `tools.exec.deniedCommands` and `tools.exec.allowedCommands` are enforced before execution.

Example:

```json
{
  "tools": {
    "policies": { "exec": "allow" },
    "exec": {
      "allowedCommands": ["npm", "node"],
      "deniedCommands": ["rm -rf *"]
    }
  }
}
```

Destructive tools still require approval. Without an explicit approved request, destructive or `ask` tools are denied safely.

## Approval Broker

MyClaw has a minimal headless `ApprovalBroker` lifecycle for `ask` and destructive paths. By default it creates a pending approval request and does not execute the tool. There is no UI or daemon; callers must provide an explicit approved `approvalId` from an authorized approver before a later call may proceed.

See `docs/approval.md` for request fields, decision permissions, and L2 audit events.

## Audit Log

Security events are also written to a separate JSONL audit log at `$MYCLAW_HOME/audit/audit.log`. This keeps policy/approval/tool/sandbox tracking separate from L2 prompt memory while preserving L2 approval `system_event` records.

See `docs/audit.md` for event types, query filters, sanitization, and limitations.

## Current Limits

- No Docker, VM, OS-level sandbox, chroot, or seccomp boundary.
- No approval UI or long-running approval service.
- No daemon/bridge/device-node security boundary.
- No production security guarantee.

Treat the workspace sandbox as a local development safety layer, not as complete containment for untrusted code.
