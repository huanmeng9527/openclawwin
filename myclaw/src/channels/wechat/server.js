/**
 * WeChat Callback Server
 * 
 * HTTP server that receives WeCom callback messages,
 * routes them through the agent loop, and returns replies.
 * 
 * Endpoints:
 *   GET  /wx/callback  — URL verification
 *   POST /wx/callback  — Message callback
 */

import http from 'node:http';
import { WeChatChannel } from './index.js';
import { AgentLoop } from '../../agent/loop.js';
import { logger } from '../../utils/logger.js';

export class WeChatServer {
  constructor(config, agent) {
    this.config = config;
    this.agent = agent;
    this.channel = new WeChatChannel(config.channels?.wechat || {});
    this.port = config.channels?.wechat?.callbackPort || 8080;
    this._server = null;
  }

  /**
   * Start the HTTP server
   */
  start() {
    this._server = http.createServer((req, res) => {
      this._handleRequest(req, res);
    });

    this._server.listen(this.port, () => {
      logger.info(`WeChat callback server listening on port ${this.port}`);
      logger.info(`Callback URL: http://your-domain:${this.port}/wx/callback`);
    });

    return this;
  }

  /**
   * Stop the server
   */
  stop() {
    if (this._server) {
      this._server.close();
      this._server = null;
    }
  }

  async _handleRequest(req, res) {
    const url = new URL(req.url, `http://localhost:${this.port}`);

    // Only handle /wx/callback
    if (url.pathname !== '/wx/callback') {
      res.writeHead(404);
      res.end('Not Found');
      return;
    }

    // GET — URL verification
    if (req.method === 'GET') {
      try {
        const msg_signature = url.searchParams.get('msg_signature') || '';
        const timestamp = url.searchParams.get('timestamp') || '';
        const nonce = url.searchParams.get('nonce') || '';
        const echostr = url.searchParams.get('echostr') || '';

        const result = this.channel.verify(msg_signature, timestamp, nonce, echostr);
        res.writeHead(200, { 'Content-Type': 'text/plain' });
        res.end(result);
      } catch (err) {
        logger.error('Verification failed:', err.message);
        res.writeHead(403);
        res.end('Verification failed');
      }
      return;
    }

    // POST — Message callback
    if (req.method === 'POST') {
      try {
        const body = await this._readBody(req);
        const message = this.channel.handleIncoming(body);

        logger.debug(`Received: [${message.msgType}] from ${message.fromUserName}: ${(message.content || '').slice(0, 100)}`);

        // Only handle text messages
        if (message.msgType === 'text' && message.content) {
          // Run agent loop
          const result = await this.agent.run(message.content, null, { stream: false });

          // Reply via callback XML
          const reply = this.channel.buildReply(
            message.fromUserName,
            message.toUserName,
            result.text
          );

          res.writeHead(200, { 'Content-Type': 'text/xml' });
          res.end(reply);
        } else {
          // Non-text: acknowledge
          res.writeHead(200, { 'Content-Type': 'text/plain' });
          res.end('success');
        }
      } catch (err) {
        logger.error('Callback error:', err.message);
        res.writeHead(200, { 'Content-Type': 'text/plain' });
        res.end('success'); // Always return 200 to WeCom
      }
      return;
    }

    res.writeHead(405);
    res.end('Method Not Allowed');
  }

  _readBody(req) {
    return new Promise((resolve, reject) => {
      const chunks = [];
      req.on('data', chunk => chunks.push(chunk));
      req.on('end', () => resolve(Buffer.concat(chunks).toString('utf-8')));
      req.on('error', reject);
    });
  }
}
