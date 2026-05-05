# Channel Bridge Skeleton

MyClaw includes a minimal channel abstraction for future multi-channel integrations. This is not a real Telegram, Discord, Feishu, WeChat, or Slack bridge.

## InternalMessage

Incoming channel payloads normalize into `InternalMessage`:

```json
{
  "id": "msg_...",
  "channel": "generic",
  "channelMessageId": "external-id",
  "conversationId": "thread-1",
  "sessionId": null,
  "userId": "user-1",
  "agentId": "myclaw",
  "sender": "user-1",
  "recipient": "myclaw",
  "text": "hello",
  "attachments": [],
  "metadata": {},
  "timestamp": "2026-05-04T00:00:00.000Z",
  "replyTo": null,
  "visibility": "private"
}
```

Text and metadata are sanitized before storage or event publication.

## ChannelBridge

`ChannelBridge` defines the transport boundary:

- `start()`
- `stop()`
- `onMessage(handler)`
- `sendMessage(reply)`
- `health()`
- `name`

Bridges must not call models, execute tools, approve requests, or write long-term memory directly. They only receive and send messages.

## ChannelRouter Flow

```text
ChannelBridge receive
  -> InternalMessage
  -> ChannelRouter.receive()
  -> QueryEngine.run()
  -> normal PromptAssembler / MemoryRouter / ToolPolicy / ApprovalBroker flow
  -> ChannelReply
  -> ChannelBridge.sendMessage()
```

Channel messages enter L2 through the normal `QueryEngine` transcript path. `ChannelRouter` keeps an in-memory conversation-to-session map for follow-up routing.

With `ChannelSessionRegistry` enabled, channel conversations are also persisted in `$MYCLAW_HOME/channels/sessions.json` and resolved before entering `QueryEngine`. Messages pass through `ChannelSecurityPolicy` first; see `docs/channel_security.md`.

## Test Bridge

`TestChannelBridge` / `DictChannelBridge` provide an in-memory inbox/outbox for tests:

- `emitMessage()`
- `getSentMessages()`
- `reset()`

## HTTP Webhook Skeleton

Generic webhook route:

```http
POST /api/channels/webhook/:channel
Authorization: Bearer <token>
Content-Type: application/json
```

Example body:

```json
{
  "id": "external-1",
  "conversationId": "conv-1",
  "userId": "user-1",
  "text": "hello"
}
```

Config:

```json
{
  "channels": {
    "enabled": [],
    "defaultAgentId": "myclaw",
    "defaultUserId": "channel-user",
    "webhook": {
      "enabled": false,
      "token": ""
    }
  }
}
```

The webhook is disabled by default. When enabled, it accepts either `channels.webhook.token`, `MYCLAW_CHANNEL_TOKEN`, `gateway.adminToken`, or `MYCLAW_ADMIN_TOKEN`.

## Audit and Events

Channel routing records:

- `channel.message.received`
- `channel.message.sent`
- `channel.message.error`

Events are published to `EventBus` and written to `AuditLog` with sanitized metadata.

## Limitations

- No real third-party platform protocol.
- No platform signature validation.
- No per-platform identity proof.
- No WebSocket bridge.
- No background scheduler.
- No production authentication beyond local token checks.
- No bypass of `QueryEngine`, `ToolPolicy`, `ApprovalBroker`, `MemoryPolicy`, `AuditLog`, `EventBus`, or workspace sandbox.
