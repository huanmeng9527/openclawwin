# Audit Log

MyClaw keeps security audit events in an append-only JSONL file while still preserving session-level L2 `system_event` records for prompt/session recall.

## L2 Transcript vs AuditLog

- **L2 session memory** stores conversational and session events used by recall and prompt context.
- **AuditLog** stores security and policy events for inspection: tool decisions, approval lifecycle, memory policy outcomes, and workspace sandbox denials.

Approval events are written to both places. AuditLog does not replace L2; it separates security tracking from prompt memory.

## Storage

Default path:

```text
$MYCLAW_HOME/audit/audit.log
```

If `MYCLAW_HOME` is not set, the path is:

```text
~/.myclaw/audit/audit.log
```

Each line is one JSON `AuditEvent`.

Audit appends use the shared JSONL storage helper and rotate the active log by default:

```json
{
  "audit": {
    "rotation": {
      "enabled": true,
      "maxSizeBytes": 10485760,
      "maxFiles": 5
    }
  }
}
```

Rotated files are named `audit.log.1`, `audit.log.2`, and so on. `AuditLog.query()` currently reads only the active `audit.log`; rotated logs are retained for manual inspection.

## Event Fields

Audit events include:

- `id`
- `timestamp`
- `eventType`
- `subject`
- `subjectRole`
- `sessionId`
- `userId`
- `agentId`
- `action`
- `resource`
- `toolName`
- `permission`
- `decision`
- `reason`
- `riskLevel`
- `approvalId`
- `metadata`
- `source`

## Recorded Event Types

- `tool.policy.allow`
- `tool.policy.deny`
- `tool.policy.ask`
- `tool.execution.start`
- `tool.execution.success`
- `tool.execution.error`
- `approval.submitted`
- `approval.approved`
- `approval.denied`
- `approval.expired`
- `memory.write.allow`
- `memory.write.deny`
- `memory.delete.allow`
- `memory.delete.deny`
- `memory.reindex.allow`
- `memory.reindex.deny`
- `workspace.sandbox.deny`

## Query Filters

`AuditLog.query(filters)` supports:

- `eventType`
- `sessionId`
- `userId`
- `agentId`
- `toolName`
- `decision`
- `approvalId`
- `since`
- `until`
- `limit`

The CLI exposes these filters through:

```bash
myclaw audit tail --lines 20
myclaw audit query --decision deny --tool exec --session session_123
```

## Sanitization

Audit metadata is sanitized before writing:

- keys containing `token`, `password`, `secret`, `api_key`, or `credential` are redacted
- binary values are omitted/redacted
- long metadata strings are truncated
- full tool results and large payloads are not stored

## Current Limitations

- No tamper-proof storage.
- No database index.
- No remote sink or SIEM integration.
- No daemon or UI for browsing audit events.
- Query does not yet include rotated audit files.
