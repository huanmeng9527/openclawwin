export class ChannelBridge {
  constructor(options = {}) {
    this.name = options.name || 'channel';
    this._handlers = new Set();
    this._started = false;
  }

  async start() {
    this._started = true;
    return this.health();
  }

  async stop() {
    this._started = false;
    return this.health();
  }

  onMessage(handler) {
    this._handlers.add(handler);
    return () => this._handlers.delete(handler);
  }

  async sendMessage(_reply) {
    throw new Error(`${this.name} does not implement sendMessage()`);
  }

  health() {
    return {
      name: this.name,
      running: this._started,
      listeners: this._handlers.size,
    };
  }

  async _emitMessage(message) {
    const results = [];
    for (const handler of [...this._handlers]) {
      results.push(await handler(message, this));
    }
    return results;
  }
}
