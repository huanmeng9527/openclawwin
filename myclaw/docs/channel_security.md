# Channel Session Registry and Security Guardrails

MyClaw channel input passes through a lightweight session registry and channel security policy before reaching `QueryEngine`.

## Session Mapping

`ChannelSessionRegistry` maps a channel identity to a stable session:

```json
{
  "id": "chanmap_...",
  "channel": "generic",
  "conversationId": "thread-1",
  "channelUserId": "external-user",
  "userId": "external-user",
  "agentId": "myclaw",
  "sessionId": "abc123",
  "createdAt": "2026-05-05T00:00:00.000Z",
  "updatedAt": "2026-05-05T00:00:00.000Z",
  "lastMessageAt": "2026-05-05T00:00:00.000Z",
  "messageCount": 1,
  "metadata": {}
}
```

The canonical file is `$MYCLAW_HOME/channels/sessions.json`. It uses atomic JSON writes, `schemaVersion`, and corrupt JSON backup/recovery. The same `channel + conversationId + channelUserId` resolves to the same mapping and session.

## Security Policy

`ChannelSecurityPolicy` checks:

- `channels.enabled`
- `channels.allowlist`
- `channels.denylist`
- `channels.maxMessageLength`
- `channels.rateLimit.enabled`
- `channels.rateLimit.windowMs`
- `channels.rateLimit.maxMessages`
- `channels.webhook.enabled` for webhook requests

Denylist wins over allowlist. If allowlist is non-empty, only matching entries are accepted. Supported list entries can be strings such as `generic:u1` or objects such as:

```json
{ "channel": "generic", "conversationId": "conv-1", "userId": "u1" }
```

## Defaults

```json
{
  "channels": {
    "enabled": [],
    "allowlist": [],
    "denylist": [],
    "maxMessageLength": 8000,
    "rateLimit": {
      "enabled": true,
      "windowMs": 60000,
      "maxMessages": 20
    },
    "sessionRegistry": {
      "enabled": true
    },
    "webhook": {
      "enabled": false,
      "token": ""
    }
  }
}
```

An empty `channels.enabled` does not restrict in-process test bridges. The HTTP webhook remains disabled by default and still requires a channel token or admin token when enabled.

## Router Flow

```text
InternalMessage
  -> ChannelSecurityPolicy.check()
  -> ChannelSessionRegistry.resolveSession()
  -> QueryEngine.run()
  -> ChannelReply
```

Denied messages do not call `QueryEngine`, do not execute tools, and do not write L3. Allowed messages use the normal `QueryEngine` path, so L2 transcript, prompt assembly, tool policy, approval, audit, and workspace sandbox remain in force.

## Audit and Events

The guardrail records:

- `channel.message.allowed`
- `channel.message.denied`
- `channel.session.resolved`
- `channel.rate_limit.denied`
- `channel.policy.denied`

Channel receive/send/error events remain recorded as before. Metadata is sanitized and truncated.

## Limitations

- No real third-party bridge.
- No platform signature validation.
- No per-platform identity proof.
- No production authentication.
- No database-backed registry.
- No distributed rate limiting.
- No background scheduler.
