# CLI Approval and Audit Commands

MyClaw includes minimal headless CLI commands for approval decisions and audit inspection. These commands do not implement a UI, daemon, bridge, database, or background approval service.

## Approval Commands

List pending approval requests:

```bash
myclaw approvals list
```

List all requests or a specific status:

```bash
myclaw approvals list --all
myclaw approvals list --status approved
```

Show one request:

```bash
myclaw approvals show appr_123
```

Approve or deny:

```bash
myclaw approvals approve appr_123 --reason "Reviewed local command"
myclaw approvals deny appr_123 --reason "Too risky"
```

Approval requests are persisted at:

```text
$MYCLAW_HOME/approvals/approvals.json
```

If `MYCLAW_HOME` is not set, MyClaw uses `~/.myclaw/approvals/approvals.json`.

## Approval Safety

- The approval CLI only changes approval decisions; it never executes tools.
- `approve` and `deny` still call `ApprovalBroker.approve()` / `ApprovalBroker.deny()` and must pass broker permission checks.
- A later approved tool call still goes through `ToolPolicy`, `PermissionRules`, input validation, and workspace sandbox checks.
- Procedural memory can provide guidance, but it cannot approve or authorize tools.
- Payload summaries are redacted/truncated before display.

## Audit Commands

Tail recent audit events:

```bash
myclaw audit tail --lines 20
```

Query audit events:

```bash
myclaw audit query --decision deny --tool exec --session session_123 --limit 50
myclaw audit query --event-type approval.denied --approval appr_123
myclaw audit query --since 2026-05-01T00:00:00.000Z --until 2026-05-04T23:59:59.999Z
```

Output columns:

- `timestamp`
- `eventType`
- `decision`
- `toolName`
- `action`
- `resource`
- `reason`
- `approvalId`

Audit events are read from:

```text
$MYCLAW_HOME/audit/audit.log
```

## Audit Limitations

- No log rotation.
- No tamper-proof hash chain.
- No database index.
- No remote sink or SIEM integration.
- No Web UI.
