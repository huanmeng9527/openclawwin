# Daemon Skeleton

MyClaw includes a minimal local daemon skeleton for running the Gateway API as a long-lived control process.

## Commands

```bash
myclaw daemon status
myclaw daemon start --foreground
myclaw daemon stop
myclaw daemon restart --foreground
```

`daemon start` currently runs in foreground mode. Full background service management is future work so the implementation stays Windows-compatible and avoids Unix-only fork behavior.

## Files

- PID file: `$MYCLAW_HOME/run/myclaw.pid`
- Log file path placeholder: `$MYCLAW_HOME/logs/daemon.log`
- Default Gateway host: `127.0.0.1`
- Default Gateway port: `3456`

`daemon stop` removes stale pid files when the recorded process no longer exists. If the pid belongs to the current foreground process, it gracefully stops the Gateway and removes the pid file.

## Gateway Integration

Daemon startup reuses the existing `Gateway` class and route table. Health and status endpoints remain available:

```bash
curl http://127.0.0.1:3456/api/health
curl http://127.0.0.1:3456/api/status
```

Management APIs still require `gateway.adminToken` or `MYCLAW_ADMIN_TOKEN`:

```bash
curl -H "Authorization: Bearer $MYCLAW_ADMIN_TOKEN" \
  http://127.0.0.1:3456/api/audit
```

If no admin token is configured, the daemon can start on localhost, but management APIs return `403`. Starting on `0.0.0.0` without an admin token is refused.

## Safety Boundaries

The daemon is a control-plane skeleton only:

- It does not auto-execute tools.
- It does not auto-approve approval requests.
- It does not write L3 semantic memory automatically.
- It does not replace ToolPolicy, PermissionRules, MemoryPolicy, ApprovalBroker, AuditLog, or workspace sandbox checks.
- It is not a bridge, scheduler, background worker, or UI.

## Current Limitations

- No service installer.
- No systemd unit.
- No Windows service integration.
- No background task scheduler.
- No daemon-to-device bridge.
- No production authentication beyond the local admin token guard.
