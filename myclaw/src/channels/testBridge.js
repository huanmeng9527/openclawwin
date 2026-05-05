import { ChannelBridge } from './bridge.js';
import { ChannelReply, InternalMessage } from './models.js';

export class TestChannelBridge extends ChannelBridge {
  constructor(options = {}) {
    super({ name: options.name || 'test', ...options });
    this.inbox = [];
    this.outbox = [];
  }

  async emitMessage(message) {
    const next = message instanceof InternalMessage
      ? message
      : new InternalMessage({ channel: this.name, ...message });
    this.inbox.push(next);
    return this._emitMessage(next);
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

  reset() {
    this.inbox = [];
    this.outbox = [];
  }
}

export class DictChannelBridge extends TestChannelBridge {}
