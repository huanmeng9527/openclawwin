import { ChannelBridge } from './bridge.js';
import { ChannelReply, InternalMessage } from './models.js';

export class HttpWebhookBridge extends ChannelBridge {
  constructor(options = {}) {
    super({ name: options.name || options.channel || 'webhook', ...options });
    this.outbox = [];
    this.config = options.config || {};
  }

  messageFromBody(channel, body = {}) {
    return new InternalMessage({
      channel,
      channelMessageId: body.channelMessageId || body.messageId || body.id || null,
      conversationId: body.conversationId || body.threadId || body.sessionId || 'default',
      sessionId: body.sessionId || null,
      userId: body.userId || this.config.channels?.defaultUserId || body.sender || null,
      agentId: body.agentId || this.config.channels?.defaultAgentId || this.config.agent?.name || null,
      sender: body.sender || body.userId || this.config.channels?.defaultUserId || 'webhook-user',
      recipient: body.recipient || body.agentId || this.config.channels?.defaultAgentId || this.config.agent?.name || 'myclaw',
      text: body.text || body.content || body.message || '',
      attachments: body.attachments || [],
      metadata: body.metadata || {},
      timestamp: body.timestamp,
      replyTo: body.replyTo || body.reply_to || null,
      visibility: body.visibility || 'private',
    });
  }

  async sendMessage(reply) {
    const next = reply instanceof ChannelReply
      ? reply
      : new ChannelReply({ channel: this.name, ...reply });
    this.outbox.push(next);
    return next;
  }

  getSentMessages() {
    return [...this.outbox];
  }
}
