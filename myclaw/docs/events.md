# Gateway Event Stream

MyClaw includes a minimal read-only event stream for future dashboards, approval review panels, and bridge-control observers.

## Endpoint

```http
GET /api/events?types=approval.submitted,memory.proposal.created&limit=50
Authorization: Bearer <token>
Accept: text/event-stream
```

The endpoint uses Server-Sent Events (SSE). On connect, it sends recent in-memory events, then streams newly published events until the client disconnects.

Supported query parameters:

- `types`: comma-separated event type filter.
- `since`: ISO timestamp lower bound for recent events.
- `limit`: maximum recent events to send on connect.

## Event Shape

```json
{
  "id": "evt_...",
  "timestamp": "2026-05-04T00:00:00.000Z",
  "type": "approval.submitted",
  "source": "approval-broker",
  "sessionId": "s1",
  "userId": "u1",
  "agentId": "myclaw",
  "approvalId": "appr_...",
  "proposalId": null,
  "toolName": "exec",
  "decision": "ask",
  "riskLevel": "high",
  "summary": "approval required",
  "metadata": {}
}
```

Metadata is sanitized and truncated before entering the stream. Keys and text containing `token`, `api_key`, `password`, `secret`, or `credential` are redacted.

## Published Events

Current skeleton publishes:

- `approval.submitted`
- `approval.approved`
- `approval.denied`
- `approval.expired`
- `audit.event`
- `memory.proposal.created`
- `memory.proposal.approved`
- `memory.proposal.rejected`
- `memory.proposal.written`
- `session.compacted`
- `tool.policy.ask`
- `tool.policy.deny`
- `tool.execution.error`

Tool result payloads are not streamed. Audit events may include short sanitized summaries only.

## Security

`/api/events` is a management API endpoint and requires `gateway.adminToken` or `MYCLAW_ADMIN_TOKEN`. It is read-only:

- It cannot approve requests.
- It cannot execute tools.
- It cannot write memory.
- It does not bypass `ApprovalBroker`, `ToolPolicy`, `MemoryPolicy`, `AuditLog`, or workspace sandbox.

## Limitations

- EventBus is in-memory only.
- Recent events disappear after restart.
- It is not an audit log and has no replay guarantee.
- It is not WebSocket.
- It has no UI.
- It has no production-grade auth, fanout control, or backpressure strategy.
