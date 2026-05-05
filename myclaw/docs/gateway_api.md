# Gateway Management API

MyClaw Gateway exposes a minimal HTTP management API for future UI/daemon integrations. This is an API skeleton only: it does not add a Web UI, daemon, bridge, database, Docker sandbox, or production authentication system.

## Security Baseline

Gateway defaults to localhost:

```json
{
  "gateway": {
    "host": "127.0.0.1",
    "port": 3456,
    "adminToken": ""
  }
}
```

Management routes require a bearer token from either `gateway.adminToken` or `MYCLAW_ADMIN_TOKEN`.

```http
Authorization: Bearer <token>
```

If no token is configured, management routes return `403` and are disabled. Public health/status/session/agent routes keep their existing behavior.

This is not production auth. There is no OAuth, user identity system, CSRF protection, per-user RBAC, or rate limiting.

## Approval API

```http
GET /api/approvals?status=pending&limit=100
GET /api/approvals?all=true
GET /api/approvals/:id
POST /api/approvals/:id/approve
POST /api/approvals/:id/deny
```

Approval API calls `ApprovalBroker`. It only changes approval decisions; it never executes tools. A later approved tool execution still goes through `ToolPolicy`, `PermissionRules`, validation, and workspace sandbox checks.

## Audit API

```http
GET /api/audit?decision=deny&tool=exec&session=s1&limit=50
GET /api/audit/tail?lines=20
```

Supported filters: `eventType`, `decision`, `tool`, `session`, `user`, `agent`, `approval`, `since`, `until`, and `limit`.

Audit API is read-only. It queries the active `audit.log`; rotated logs are retained but not searched yet.

## Event Stream API

```http
GET /api/events?types=approval.submitted,tool.policy.deny&limit=50
Authorization: Bearer <token>
```

`/api/events` is a read-only Server-Sent Events endpoint. It sends recent in-memory events on connect, then streams new events until disconnect. It does not persist events and does not replace `AuditLog`. See `docs/events.md`.

## Memory Proposal API

```http
GET /api/memory/proposals?status=pending&type=preference&session=s1&limit=100
GET /api/memory/proposals/:id
POST /api/memory/proposals/:id/approve
POST /api/memory/proposals/:id/reject
POST /api/memory/proposals/:id/write
```

Proposal approval and write use `MemoryProposalStore`. Writing still goes through `MemoryRouter.write(..., "semantic")` and `MemoryPolicyGate`. Rejected proposals cannot be written to L3.

## Current Limitations

- No Web UI.
- No daemon or remote bridge.
- No user auth or OAuth.
- No CSRF protection.
- No production hardening guarantee.
- No database-backed query/index layer.
- No rotated audit-log search.
- No persistent event replay or WebSocket bridge.
