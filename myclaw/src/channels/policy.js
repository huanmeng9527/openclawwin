export class ChannelSecurityPolicy {
  constructor(config = {}, options = {}) {
    this.config = config;
    this._recentByKey = new Map();
    this.now = options.now || (() => Date.now());
  }

  check(message, context = {}) {
    const settings = channelSettings(this.config);

    if (context.webhook && settings.webhook.enabled === false) {
      return deny('channel.policy.denied', 'Channel webhook is disabled', 404);
    }

    if (settings.enabled.length > 0 && !settings.enabled.includes(message.channel)) {
      return deny('channel.policy.denied', `Channel "${message.channel}" is not enabled`, 403);
    }

    if (matchesList(settings.denylist, message)) {
      return deny('channel.policy.denied', 'Channel message blocked by denylist', 403);
    }

    if (settings.allowlist.length > 0 && !matchesList(settings.allowlist, message)) {
      return deny('channel.policy.denied', 'Channel message sender is not allowlisted', 403);
    }

    if (String(message.text || '').length > settings.maxMessageLength) {
      return deny('channel.policy.denied', `Channel message exceeds max length ${settings.maxMessageLength}`, 400);
    }

    if (settings.rateLimit.enabled) {
      const rate = this._checkRateLimit(message, settings.rateLimit);
      if (!rate.allowed) {
        return {
          allowed: false,
          decision: 'deny',
          reason: `Channel rate limit exceeded (${settings.rateLimit.maxMessages}/${settings.rateLimit.windowMs}ms)`,
          eventType: 'channel.rate_limit.denied',
          status: 429,
          retryAfterMs: rate.retryAfterMs,
          metadata: {
            windowMs: settings.rateLimit.windowMs,
            maxMessages: settings.rateLimit.maxMessages,
          },
        };
      }
    }

    return {
      allowed: true,
      decision: 'allow',
      reason: 'channel message allowed',
      eventType: 'channel.message.allowed',
      status: 200,
    };
  }

  _checkRateLimit(message, settings) {
    const key = rateLimitKey(message);
    const now = this.now();
    const windowStart = now - settings.windowMs;
    const recent = (this._recentByKey.get(key) || []).filter(timestamp => timestamp > windowStart);
    if (recent.length >= settings.maxMessages) {
      const oldest = Math.min(...recent);
      this._recentByKey.set(key, recent);
      return { allowed: false, retryAfterMs: Math.max(0, settings.windowMs - (now - oldest)) };
    }
    recent.push(now);
    this._recentByKey.set(key, recent);
    return { allowed: true, retryAfterMs: 0 };
  }
}

export class ChannelPolicyError extends Error {
  constructor(decision = {}) {
    super(decision.reason || 'Channel policy denied message');
    this.name = 'ChannelPolicyError';
    this.decision = decision;
    this.status = decision.status || 403;
  }
}

export function channelSettings(config = {}) {
  const channels = config.channels || {};
  return {
    enabled: channels.enabled || [],
    allowlist: channels.allowlist || [],
    denylist: channels.denylist || [],
    maxMessageLength: channels.maxMessageLength || 8000,
    webhook: {
      enabled: channels.webhook?.enabled === true,
      token: channels.webhook?.token || '',
    },
    rateLimit: {
      enabled: channels.rateLimit?.enabled !== false,
      windowMs: channels.rateLimit?.windowMs || 60000,
      maxMessages: channels.rateLimit?.maxMessages || 20,
    },
  };
}

function deny(eventType, reason, status) {
  return {
    allowed: false,
    decision: 'deny',
    reason,
    eventType,
    status,
  };
}

function matchesList(entries = [], message) {
  return entries.some(entry => matchesEntry(entry, message));
}

function matchesEntry(entry, message) {
  if (!entry) return false;
  if (typeof entry === 'string') {
    const values = new Set([
      message.channel,
      message.userId,
      message.sender,
      message.conversationId,
      `${message.channel}:${message.userId || message.sender || 'anonymous'}`,
      `${message.channel}:${message.conversationId}`,
      `${message.channel}:${message.conversationId}:${message.userId || message.sender || 'anonymous'}`,
    ].filter(Boolean));
    return values.has(entry);
  }
  if (typeof entry !== 'object') return false;
  if (entry.channel && entry.channel !== message.channel) return false;
  if (entry.userId && entry.userId !== message.userId && entry.userId !== message.sender) return false;
  if (entry.channelUserId && entry.channelUserId !== message.userId && entry.channelUserId !== message.sender) return false;
  if (entry.sender && entry.sender !== message.sender) return false;
  if (entry.conversationId && entry.conversationId !== message.conversationId) return false;
  return true;
}

function rateLimitKey(message) {
  return [
    message.channel || 'unknown',
    message.conversationId || 'default',
    message.userId || message.sender || 'anonymous',
  ].join('|');
}
