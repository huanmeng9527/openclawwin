/**
 * Channel Manager
 * 
 * Manages channel adapters and provides unified message routing.
 * 
 * Supported channels:
 *   - wechat (企业微信 WeCom) — webhook + callback
 *   - (future: telegram, discord, slack, etc.)
 */

import { WeChatChannel } from './wechat/index.js';
export { ChannelBridge } from './bridge.js';
export { ChannelReply, InternalMessage } from './models.js';
export { ChannelPolicyError, ChannelSecurityPolicy, channelSettings } from './policy.js';
export { ChannelRouter } from './router.js';
export {
  ChannelSessionMapping,
  ChannelSessionRegistry,
  defaultChannelSessionRegistryPath,
} from './sessionRegistry.js';
export { DictChannelBridge, TestChannelBridge } from './testBridge.js';
export { HttpWebhookBridge } from './httpWebhook.js';

const CHANNEL_CLASSES = {
  wechat: WeChatChannel,
  // telegram: TelegramChannel,
  // discord: DiscordChannel,
};

export class ChannelManager {
  constructor(config = {}) {
    this._channels = new Map();
    this._config = config.channels || {};

    // Auto-register configured channels
    for (const [name, channelConfig] of Object.entries(this._config)) {
      if (CHANNEL_CLASSES[name]) {
        this.register(name, new CHANNEL_CLASSES[name](channelConfig));
      }
    }
  }

  /**
   * Register a channel
   */
  register(name, channel) {
    this._channels.set(name, channel);
    return this;
  }

  /**
   * Get a channel by name
   */
  get(name) {
    return this._channels.get(name);
  }

  /**
   * Send a message via a specific channel
   */
  async send(channelName, message, context = {}) {
    const channel = this._channels.get(channelName);
    if (!channel) {
      throw new Error(`Channel not found: ${channelName}`);
    }
    return channel.send(message, context);
  }

  /**
   * Broadcast a message to all channels
   */
  async broadcast(message, context = {}) {
    const results = {};
    for (const [name, channel] of this._channels) {
      try {
        results[name] = await channel.send(message, context);
      } catch (err) {
        results[name] = { error: err.message };
      }
    }
    return results;
  }

  /**
   * List registered channels
   */
  list() {
    return Array.from(this._channels.keys());
  }

  /**
   * Check if a channel is registered
   */
  has(name) {
    return this._channels.has(name);
  }
}
