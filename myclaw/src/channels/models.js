import crypto from 'node:crypto';
import { redactSecretText, sanitizeValue, truncate } from '../memory/sanitizer.js';

export class InternalMessage {
  constructor(data = {}) {
    this.id = data.id || createChannelId('msg');
    this.channel = safeText(data.channel || 'unknown', 80);
    this.channelMessageId = data.channelMessageId || data.channel_message_id || data.messageId || data.message_id || null;
    this.conversationId = data.conversationId || data.conversation_id || data.threadId || data.thread_id || 'default';
    this.sessionId = data.sessionId || data.session_id || null;
    this.userId = data.userId || data.user_id || data.sender || null;
    this.agentId = data.agentId || data.agent_id || null;
    this.sender = safeText(data.sender || data.userId || data.user_id || 'user', 160);
    this.recipient = safeText(data.recipient || data.agentId || data.agent_id || 'myclaw', 160);
    this.text = safeText(data.text || data.content || data.message || '', 20000);
    this.attachments = sanitizeValue(data.attachments || [], { maxChars: 1000 });
    this.metadata = sanitizeValue(data.metadata || {}, { maxChars: 1000 });
    this.timestamp = data.timestamp || new Date().toISOString();
    this.replyTo = data.replyTo || data.reply_to || null;
    this.visibility = data.visibility || 'private';
  }

  toJSON() {
    return { ...this };
  }
}

export class ChannelReply {
  constructor(data = {}) {
    this.id = data.id || createChannelId('reply');
    this.channel = safeText(data.channel || 'unknown', 80);
    this.conversationId = data.conversationId || data.conversation_id || 'default';
    this.text = safeText(data.text || data.content || '', 4000);
    this.metadata = sanitizeValue(data.metadata || {}, { maxChars: 1000 });
    this.timestamp = data.timestamp || new Date().toISOString();
  }

  toJSON() {
    return { ...this };
  }
}

export function createChannelId(prefix = 'channel') {
  return `${prefix}_${crypto.randomBytes(8).toString('hex')}`;
}

function safeText(value, maxChars) {
  return truncate(redactSecretText(String(value || '')), maxChars);
}
