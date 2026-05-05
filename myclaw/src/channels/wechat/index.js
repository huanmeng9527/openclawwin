/**
 * WeChat Channel Adapter — 企业微信 (WeCom)
 * 
 * Two modes:
 *   1. Webhook mode: Send messages to a WeCom group via webhook bot
 *   2. Callback mode: Receive & reply via WeCom app callback API
 * 
 * Webhook setup:
 *   - Create a bot in a WeCom group chat
 *   - Copy the webhook URL
 *   - Configure: channels.wechat.webhookUrl
 * 
 * Callback setup:
 *   - Create a WeCom app (自建应用)
 *   - Configure: corpId, agentId, secret, token, encodingAESKey
 *   - Set callback URL in WeCom admin console
 */

import crypto from 'node:crypto';

// ── Webhook Mode ──

export class WeChatWebhook {
  constructor(config) {
    this.webhookUrl = config.webhookUrl || '';
    this.mentionedList = config.mentionedList || [];
  }

  /**
   * Send a text message to the group
   */
  async sendText(content, mentioned = []) {
    return this._send({
      msgtype: 'text',
      text: {
        content,
        mentioned_list: mentioned.length > 0 ? mentioned : this.mentionedList,
      },
    });
  }

  /**
   * Send a markdown message
   */
  async sendMarkdown(content) {
    return this._send({
      msgtype: 'markdown',
      markdown: { content },
    });
  }

  /**
   * Send an image
   */
  async sendImage(base64, md5) {
    return this._send({
      msgtype: 'image',
      image: { base64, md5 },
    });
  }

  /**
   * Send a news card
   */
  async sendNews(articles) {
    return this._send({
      msgtype: 'news',
      news: { articles },
    });
  }

  async _send(body) {
    if (!this.webhookUrl) {
      throw new Error('WeChat webhook URL not configured');
    }

    const response = await fetch(this.webhookUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });

    const data = await response.json();

    if (data.errcode !== 0) {
      throw new Error(`WeChat webhook error ${data.errcode}: ${data.errmsg}`);
    }

    return data;
  }
}

// ── Callback Mode (接收消息) ──

export class WeChatCallback {
  constructor(config) {
    this.corpId = config.corpId || '';
    this.agentId = config.agentId || '';
    this.secret = config.secret || '';
    this.token = config.token || '';
    this.encodingAESKey = config.encodingAESKey || '';
    this._accessToken = null;
    this._tokenExpiry = 0;
  }

  /**
   * Verify callback signature (for URL verification request)
   */
  verifySignature(signature, timestamp, nonce, echostr) {
    const arr = [this.token, timestamp, nonce].sort();
    const str = arr.join('');
    const hash = crypto.createHash('sha1').update(str).digest('hex');

    if (hash !== signature) {
      throw new Error('Invalid signature');
    }

    // Decrypt echostr if AES key is set
    if (this.encodingAESKey && echostr) {
      return this._decrypt(echostr);
    }
    return echostr || 'success';
  }

  /**
   * Parse incoming callback message XML
   */
  parseMessage(xmlBody) {
    // Simple XML parser for WeCom message format
    const extract = (tag) => {
      const match = xmlBody.match(new RegExp(`<${tag}>(?:<!\\[CDATA\\[)?(.*?)(?:\\]\\]>)?</${tag}>`));
      return match ? match[1] : '';
    };

    return {
      toUserName: extract('ToUserName'),
      fromUserName: extract('FromUserName'),
      createTime: parseInt(extract('CreateTime'), 10),
      msgType: extract('MsgType'),
      content: extract('Content'),
      msgId: extract('MsgId'),
      agentId: extract('AgentID'),
      // Image
      picUrl: extract('PicUrl'),
      mediaId: extract('MediaId'),
      // Event
      event: extract('Event'),
      eventKey: extract('EventKey'),
    };
  }

  /**
   * Build XML reply message
   */
  buildReply(toUser, fromUser, content, msgType = 'text') {
    const timestamp = Math.floor(Date.now() / 1000);

    if (msgType === 'text') {
      return `<xml>
<ToUserName><![CDATA[${toUser}]]></ToUserName>
<FromUserName><![CDATA[${fromUser}]]></FromUserName>
<CreateTime>${timestamp}</CreateTime>
<MsgType><![CDATA[text]]></MsgType>
<Content><![CDATA[${content}]]></Content>
</xml>`;
    }

    if (msgType === 'markdown') {
      return `<xml>
<ToUserName><![CDATA[${toUser}]]></ToUserName>
<FromUserName><![CDATA[${fromUser}]]></FromUserName>
<CreateTime>${timestamp}</CreateTime>
<MsgType><![CDATA[markdown]]></MsgType>
<Markdown>
<Content><![CDATA[${content}]]></Content>
</Markdown>
</xml>`;
    }

    return '';
  }

  /**
   * Get access token (for主动发送消息)
   */
  async getAccessToken() {
    if (this._accessToken && Date.now() < this._tokenExpiry) {
      return this._accessToken;
    }

    const url = `https://qyapi.weixin.qq.com/cgi-bin/gettoken?corpid=${this.corpId}&corpsecret=${this.secret}`;
    const response = await fetch(url);
    const data = await response.json();

    if (data.errcode !== 0) {
      throw new Error(`WeChat token error: ${data.errmsg}`);
    }

    this._accessToken = data.access_token;
    this._tokenExpiry = Date.now() + (data.expires_in - 300) * 1000; // 5min buffer
    return this._accessToken;
  }

  /**
   * Send message to a user (主动发送)
   */
  async sendMessage(userId, content, msgType = 'text') {
    const token = await this.getAccessToken();
    const url = `https://qyapi.weixin.qq.com/cgi-bin/message/send?access_token=${token}`;

    const body = {
      touser: userId,
      msgtype: msgType,
      agentid: parseInt(this.agentId, 10),
    };

    if (msgType === 'text') {
      body.text = { content };
    } else if (msgType === 'markdown') {
      body.markdown = { content };
    }

    const response = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });

    const data = await response.json();
    if (data.errcode !== 0) {
      throw new Error(`WeChat send error ${data.errcode}: ${data.errmsg}`);
    }
    return data;
  }

  /**
   * Decrypt AES-encrypted message
   */
  _decrypt(encrypted) {
    if (!this.encodingAESKey) return encrypted;

    const key = Buffer.from(this.encodingAESKey + '=', 'base64');
    const iv = key.slice(0, 16);
    const decipher = crypto.createDecipheriv('aes-256-cbc', key, iv);
    let decrypted = decipher.update(encrypted, 'base64', 'utf8');
    decrypted += decipher.final('utf8');
    return decrypted;
  }
}

/**
 * WeChat Channel — unified interface
 * 
 * Wraps webhook + callback into a channel that the agent can use
 */
export class WeChatChannel {
  constructor(config) {
    this.webhook = new WeChatWebhook(config);
    this.callback = new WeChatCallback(config);
    this.name = 'wechat';
  }

  /**
   * Send a reply (auto-selects webhook or callback based on context)
   */
  async send(message, context = {}) {
    const { userId, groupId, useMarkdown } = context;

    // If we have a userId, use callback API to send directly
    if (userId) {
      return this.callback.sendMessage(
        userId,
        message,
        useMarkdown ? 'markdown' : 'text'
      );
    }

    // Otherwise use webhook (group bot)
    if (useMarkdown) {
      return this.webhook.sendMarkdown(message);
    }
    return this.webhook.sendText(message);
  }

  /**
   * Handle incoming message from callback
   */
  handleIncoming(xmlBody) {
    return this.callback.parseMessage(xmlBody);
  }

  /**
   * Verify callback URL
   */
  verify(signature, timestamp, nonce, echostr) {
    return this.callback.verifySignature(signature, timestamp, nonce, echostr);
  }

  /**
   * Build XML reply for callback
   */
  buildReply(toUser, fromUser, content) {
    return this.callback.buildReply(toUser, fromUser, content);
  }
}
