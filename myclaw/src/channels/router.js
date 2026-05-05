import { ChannelReply, InternalMessage } from './models.js';
import { ChannelSecurityPolicy } from './policy.js';
import { ChannelSessionRegistry } from './sessionRegistry.js';
import { redactSecretText, truncate } from '../memory/sanitizer.js';

export class ChannelRouter {
  constructor(options = {}) {
    this.config = options.config || {};
    this.engine = options.engine;
    this.auditLog = options.auditLog || options.engine?.auditLog || null;
    this.eventBus = options.eventBus || options.engine?.eventBus || null;
    this.defaultBridge = options.bridge || null;
    this.policy = options.policy || new ChannelSecurityPolicy(this.config);
    this.sessionRegistry = options.sessionRegistry === null || this.config.channels?.sessionRegistry?.enabled === false
      ? null
      : options.sessionRegistry || new ChannelSessionRegistry({ config: this.config });
    this._conversationSessions = new Map();
  }

  attachBridge(bridge) {
    bridge.onMessage((message) => this.receive(message, bridge));
    return bridge;
  }

  async receive(message, bridge = this.defaultBridge) {
    const next = message instanceof InternalMessage
      ? message
      : new InternalMessage(message);
    const activeBridge = bridge || this.defaultBridge;
    if (!activeBridge) throw new Error(`No bridge available for channel ${next.channel}`);
    if (!this.engine?.run) throw new Error('ChannelRouter requires a QueryEngine-compatible engine');

    this._record('channel.message.received', next, null, {
      decision: null,
      summary: `received ${next.channel} message`,
    });

    const policyDecision = this.policy.check(next, {
      bridge: activeBridge.name,
      webhook: activeBridge.name === 'webhook' || activeBridge.constructor?.name === 'HttpWebhookBridge',
    });
    if (!policyDecision.allowed) {
      this._record(policyDecision.eventType || 'channel.policy.denied', next, null, {
        decision: 'deny',
        summary: policyDecision.reason,
        metadata: {
          status: policyDecision.status,
          retryAfterMs: policyDecision.retryAfterMs,
          ...(policyDecision.metadata || {}),
        },
      });
      this._record('channel.message.denied', next, null, {
        decision: 'deny',
        summary: policyDecision.reason,
        metadata: {
          status: policyDecision.status,
          policyEventType: policyDecision.eventType,
        },
      });
      return {
        denied: true,
        status: policyDecision.status || 403,
        decision: policyDecision,
        message: next,
        reply: null,
        result: null,
      };
    }

    try {
      const mapping = this._resolveMapping(next);
      next.sessionId = mapping?.sessionId || next.sessionId || null;
      next.userId = mapping?.userId || next.userId || this.config.channels?.defaultUserId || null;
      next.agentId = mapping?.agentId || next.agentId || this.config.channels?.defaultAgentId || this.config.agent?.name || null;
      this._record('channel.message.allowed', next, null, {
        decision: 'allow',
        summary: `allowed ${next.channel} message`,
      });
      if (mapping) {
        this._record('channel.session.resolved', next, null, {
          decision: 'allow',
          summary: `resolved ${next.channel} session`,
          metadata: {
            mappingId: mapping.id,
            messageCount: mapping.messageCount,
          },
        });
      }

      const sessionId = next.sessionId || this._resolveSessionId(next);
      const result = await this.engine.run(next.text, sessionId, {
        stream: false,
        userId: next.userId || this.config.channels?.defaultUserId || null,
        laneId: `channel:${next.channel}`,
      });
      const resolvedSessionId = result.session?.id || sessionId || null;
      if (mapping && mapping.sessionId !== resolvedSessionId) {
        mapping.sessionId = resolvedSessionId;
        this.sessionRegistry?.upsertMapping?.(mapping);
      } else {
        this._rememberSession(next, resolvedSessionId);
      }

      const reply = new ChannelReply({
        channel: next.channel,
        conversationId: next.conversationId,
        text: result.text || '',
        metadata: {
          sessionId: resolvedSessionId,
          sourceMessageId: next.id,
        },
      });
      const sent = await activeBridge.sendMessage(reply);
      this._record('channel.message.sent', next, sent, {
        decision: 'allow',
        summary: `sent ${next.channel} reply`,
      });
      return { message: next, reply: sent, result };
    } catch (err) {
      this._record('channel.message.error', next, null, {
        decision: 'error',
        summary: err.message,
        metadata: { errorName: err.name },
      });
      throw err;
    }
  }

  _resolveSessionId(message) {
    if (message.sessionId) return message.sessionId;
    return this._conversationSessions.get(conversationKey(message)) || null;
  }

  _resolveMapping(message) {
    if (!this.sessionRegistry) return null;
    return this.sessionRegistry.resolveSession(message, {
      sessionManager: this.engine.sessions,
      user_id: message.userId || this.config.channels?.defaultUserId,
      agent_id: message.agentId || this.config.channels?.defaultAgentId || this.config.agent?.name,
      defaultUserId: this.config.channels?.defaultUserId || 'channel-user',
      defaultAgentId: this.config.channels?.defaultAgentId || this.config.agent?.name || 'myclaw',
    });
  }

  _rememberSession(message, sessionId) {
    if (!sessionId) return;
    this._conversationSessions.set(conversationKey(message), sessionId);
  }

  _record(eventType, message, reply = null, details = {}) {
    const summary = safeText(details.summary || eventType, 500);
    const metadata = {
      channel: message.channel,
      channelMessageId: message.channelMessageId,
      conversationId: message.conversationId,
      replyId: reply?.id || null,
      replyTextSummary: reply?.text ? truncate(reply.text, 300) : undefined,
      ...(details.metadata || {}),
    };
    this.auditLog?.write?.({
      eventType,
      subject: message.id,
      subjectRole: 'channel_message',
      sessionId: message.sessionId || reply?.metadata?.sessionId || null,
      userId: message.userId || null,
      agentId: message.agentId || this.config.channels?.defaultAgentId || this.config.agent?.name || null,
      action: eventType,
      resource: message.channel,
      decision: details.decision || null,
      reason: summary,
      riskLevel: 'low',
      metadata,
      source: 'channel-router',
    });
    this.eventBus?.publish?.({
      type: eventType,
      source: 'channel-router',
      sessionId: message.sessionId || reply?.metadata?.sessionId || null,
      userId: message.userId || null,
      agentId: message.agentId || this.config.channels?.defaultAgentId || this.config.agent?.name || null,
      decision: details.decision || null,
      riskLevel: 'low',
      summary,
      metadata,
    });
  }
}

function conversationKey(message) {
  return `${message.channel}:${message.conversationId || 'default'}:${message.userId || 'anonymous'}`;
}

function safeText(value, maxChars) {
  return truncate(redactSecretText(String(value || '')), maxChars);
}
