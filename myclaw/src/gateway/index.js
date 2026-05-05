/**
 * Gateway HTTP API Server
 * 
 * Provides a REST API for the agent:
 *   POST /api/agent          — send a message, get response
 *   GET  /api/sessions       — list sessions
 *   POST /api/sessions       — create session
 *   GET  /api/sessions/:id   — get session details
 *   GET  /api/status         — server status
 *   GET  /api/health         — health check
 */

import http from 'node:http';
import { APPROVAL_PERMISSIONS } from '../approval/index.js';
import { ChannelRouter, HttpWebhookBridge } from '../channels/index.js';
import { QueryEngine } from '../engine/query.js';
import { MEMORY_PERMISSIONS } from '../memory/index.js';
import { redactSecretText } from '../memory/sanitizer.js';
import { logger } from '../utils/logger.js';

export class Gateway {
  constructor(config, deps = {}) {
    this.config = config;
    this.engine = deps.engine || null;
    this.engineDeps = deps.engineDeps || {};
    this.channelRouter = deps.channelRouter || null;
    this.port = config.gateway?.port ?? 3456;
    this.host = config.gateway?.host || '127.0.0.1';
    this._server = null;
    this._startedAt = null;
  }

  async start() {
    if (!this.engine) {
      this.engine = new QueryEngine(this.config, this.engineDeps);
      await this.engine.init();
    }
    if (!this.channelRouter) {
      this.channelRouter = new ChannelRouter({
        config: this.config,
        engine: this.engine,
        auditLog: this.engine.auditLog,
        eventBus: this.engine.eventBus,
      });
    }

    this._server = http.createServer((req, res) => this._handle(req, res));
    this._startedAt = new Date().toISOString();

    return new Promise((resolve) => {
      this._server.listen(this.port, this.host, () => {
        logger.info(`Gateway listening on ${this.host}:${this.port}`);
        resolve();
      });
    });
  }

  stop() {
    if (!this._server) return Promise.resolve();
    const server = this._server;
    this._server = null;
    return new Promise((resolve) => {
      server.close(() => resolve());
    });
  }

  async _handle(req, res) {
    // CORS
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');

    if (req.method === 'OPTIONS') {
      res.writeHead(204);
      res.end();
      return;
    }

    const url = new URL(req.url, `http://${this.host}:${this.port}`);

    try {
      // ── Health ──
      if (url.pathname === '/api/health' && req.method === 'GET') {
        return this._json(res, 200, { status: 'ok' });
      }

      // ── Status ──
      if (url.pathname === '/api/status' && req.method === 'GET') {
        return this._json(res, 200, {
          status: 'running',
          startedAt: this._startedAt,
          agent: this.config.agent?.name || 'myclaw',
          model: this.config.provider?.model,
          provider: this.config.provider?.type,
          tools: this.engine.getToolNames(),
          uptime: Math.floor((Date.now() - new Date(this._startedAt).getTime()) / 1000),
        });
      }

      // ── Agent ──
      if (url.pathname === '/api/agent' && req.method === 'POST') {
        const body = await this._readBody(req);
        const { message, sessionId, stream } = body;

        if (!message) {
          return this._json(res, 400, { error: 'Missing "message" field' });
        }

        // Streaming response
        if (stream) {
          res.writeHead(200, {
            'Content-Type': 'text/event-stream',
            'Cache-Control': 'no-cache',
            'Connection': 'keep-alive',
          });

          for await (const event of this.engine.query(message, sessionId)) {
            res.write(`data: ${JSON.stringify(event)}\n\n`);
          }
          res.write('data: [DONE]\n\n');
          res.end();
          return;
        }

        // Non-streaming
        const result = await this.engine.run(message, sessionId);
        return this._json(res, 200, {
          text: result.text,
          sessionId: result.session?.id,
          usage: result.usage,
          iterations: result.iterations,
        });
      }

      // ── Management APIs ──
      const webhookMatch = url.pathname.match(/^\/api\/channels\/webhook\/([^/]+)$/);
      if (webhookMatch) {
        const response = await this._handleChannelWebhookApi(req, url, webhookMatch[1]);
        return this._json(res, response.status, response.body);
      }

      if (isManagementPath(url.pathname)) {
        const authError = this._authorizeManagement(req);
        if (authError) return this._json(res, authError.status, { error: authError.message });

        if (url.pathname === '/api/events') {
          if (req.method !== 'GET') return this._json(res, 405, { error: 'Method not allowed' });
          return this._handleEventsSse(req, res, url);
        }

        const approvalResponse = await this._handleApprovalApi(req, url);
        if (approvalResponse) return this._json(res, approvalResponse.status, approvalResponse.body);

        const auditResponse = await this._handleAuditApi(req, url);
        if (auditResponse) return this._json(res, auditResponse.status, auditResponse.body);

        const proposalResponse = await this._handleMemoryProposalApi(req, url);
        if (proposalResponse) return this._json(res, proposalResponse.status, proposalResponse.body);
      }

      // ── Sessions ──
      if (url.pathname === '/api/sessions' && req.method === 'GET') {
        const sessions = this.engine.sessions.list();
        return this._json(res, 200, { sessions });
      }

      if (url.pathname === '/api/sessions' && req.method === 'POST') {
        const body = await this._readBody(req);
        const session = this.engine.sessions.create(body.name || '');
        return this._json(res, 201, { id: session.id, name: session.name });
      }

      // ── Session by ID ──
      const sessionMatch = url.pathname.match(/^\/api\/sessions\/(\w+)$/);
      if (sessionMatch && req.method === 'GET') {
        try {
          const session = this.engine.sessions.load(sessionMatch[1]);
          return this._json(res, 200, session.summary);
        } catch {
          return this._json(res, 404, { error: 'Session not found' });
        }
      }

      // ── Not found ──
      return this._json(res, 404, { error: `Not found: ${req.method} ${url.pathname}` });

    } catch (err) {
      logger.error(`Gateway error: ${err.message}`);
      return this._json(res, 500, { error: err.message });
    }
  }

  async _handleApprovalApi(req, url) {
    if (url.pathname === '/api/approvals' && req.method === 'GET') {
      const status = url.searchParams.get('status');
      const all = parseBoolean(url.searchParams.get('all'));
      const limit = parseLimit(url.searchParams.get('limit'), 100);
      const requests = this.engine.approvalBroker
        .list(all ? {} : status ? { status } : { status: 'pending' })
        .slice(0, limit)
        .map(sanitizeApproval);
      return { status: 200, body: { approvals: requests } };
    }

    const match = url.pathname.match(/^\/api\/approvals\/([^/]+)(?:\/(approve|deny))?$/);
    if (!match) return null;
    const request = this.engine.approvalBroker.get(match[1]);
    if (!request) return { status: 404, body: { error: 'Approval request not found' } };

    if (!match[2] && req.method === 'GET') {
      return { status: 200, body: sanitizeApproval(request) };
    }

    if (match[2] === 'approve' && req.method === 'POST') {
      const body = await this._readBody(req);
      const approved = this.engine.approvalBroker.approve(request.id, this._adminContext(request), body.reason || 'approved by gateway');
      return { status: 200, body: sanitizeApproval(approved) };
    }

    if (match[2] === 'deny' && req.method === 'POST') {
      const body = await this._readBody(req);
      const denied = this.engine.approvalBroker.deny(request.id, this._adminContext(request), body.reason || 'denied by gateway');
      return { status: 200, body: sanitizeApproval(denied) };
    }

    return { status: 405, body: { error: 'Method not allowed' } };
  }

  async _handleAuditApi(req, url) {
    if (url.pathname === '/api/audit/tail' && req.method === 'GET') {
      const lines = parseLimit(url.searchParams.get('lines'), 20);
      return { status: 200, body: { events: this.engine.auditLog.query({ limit: lines }).map(sanitizeAuditEvent) } };
    }

    if (url.pathname !== '/api/audit' || req.method !== 'GET') return null;
    const filters = {
      eventType: url.searchParams.get('eventType') || undefined,
      decision: url.searchParams.get('decision') || undefined,
      toolName: url.searchParams.get('tool') || undefined,
      sessionId: url.searchParams.get('session') || undefined,
      userId: url.searchParams.get('user') || undefined,
      agentId: url.searchParams.get('agent') || undefined,
      approvalId: url.searchParams.get('approval') || undefined,
      since: url.searchParams.get('since') || undefined,
      until: url.searchParams.get('until') || undefined,
      limit: parseLimit(url.searchParams.get('limit'), 100),
    };
    return { status: 200, body: { events: this.engine.auditLog.query(filters).map(sanitizeAuditEvent) } };
  }

  async _handleMemoryProposalApi(req, url) {
    if (url.pathname === '/api/memory/proposals' && req.method === 'GET') {
      const filters = {
        status: url.searchParams.get('status') || undefined,
        type: url.searchParams.get('type') || undefined,
        sourceSessionId: url.searchParams.get('session') || undefined,
      };
      const limit = parseLimit(url.searchParams.get('limit'), 100);
      const proposals = this.engine.memoryProposals.listProposals(filters).slice(0, limit).map(sanitizeProposal);
      return { status: 200, body: { proposals } };
    }

    const match = url.pathname.match(/^\/api\/memory\/proposals\/([^/]+)(?:\/(approve|reject|write))?$/);
    if (!match) return null;
    const proposal = this.engine.memoryProposals.getProposal(match[1]);
    if (!proposal) return { status: 404, body: { error: 'Memory proposal not found' } };

    if (!match[2] && req.method === 'GET') {
      return { status: 200, body: sanitizeProposal(proposal) };
    }

    if (match[2] === 'approve' && req.method === 'POST') {
      const body = await this._readBody(req);
      const approved = this.engine.memoryProposals.approveProposal(proposal.id, this._adminContext(proposal), body.reason || 'approved by gateway');
      return { status: 200, body: sanitizeProposal(approved) };
    }

    if (match[2] === 'reject' && req.method === 'POST') {
      const body = await this._readBody(req);
      const rejected = this.engine.memoryProposals.rejectProposal(proposal.id, this._adminContext(proposal), body.reason || 'rejected by gateway');
      return { status: 200, body: sanitizeProposal(rejected) };
    }

    if (match[2] === 'write' && req.method === 'POST') {
      const written = this.engine.memoryProposals.writeApprovedProposal(proposal.id, this._adminContext(proposal));
      return { status: 200, body: sanitizeProposal(written) };
    }

    return { status: 405, body: { error: 'Method not allowed' } };
  }

  async _handleChannelWebhookApi(req, _url, channel) {
    if (!this.config.channels?.webhook?.enabled) {
      return { status: 404, body: { error: 'Channel webhook is disabled' } };
    }
    if (req.method !== 'POST') {
      return { status: 405, body: { error: 'Method not allowed' } };
    }
    const authError = this._authorizeChannelWebhook(req);
    if (authError) return { status: authError.status, body: { error: authError.message } };

    const body = await this._readBody(req);
    const bridge = new HttpWebhookBridge({ channel, config: this.config });
    const message = bridge.messageFromBody(channel, body);
    const routed = await this.channelRouter.receive(message, bridge);
    if (routed.denied) {
      return {
        status: routed.status || 403,
        body: {
          ok: false,
          channel,
          messageId: routed.message.id,
          error: routed.decision?.reason || 'Channel message denied',
          decision: routed.decision,
        },
      };
    }
    return {
      status: 200,
      body: {
        ok: true,
        channel,
        messageId: routed.message.id,
        sessionId: routed.result.session?.id || routed.reply.metadata?.sessionId || null,
        reply: routed.reply.toJSON ? routed.reply.toJSON() : routed.reply,
      },
    };
  }

  _handleEventsSse(req, res, url) {
    const filters = parseEventFilters(url);
    const eventBus = this.engine.eventBus;

    res.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache, no-transform',
      'Connection': 'keep-alive',
      'X-Accel-Buffering': 'no',
    });
    res.write(': myclaw event stream connected\n\n');

    const send = (event) => {
      if (!matchesEventFilters(event, filters)) return;
      res.write(formatSseEvent(event));
    };

    for (const event of eventBus.recent(filters.limit)) send(event);

    const unsubscribe = eventBus.subscribe(send);
    const cleanup = () => unsubscribe();
    req.on('close', cleanup);
    req.on('aborted', cleanup);
    res.on('close', cleanup);
  }

  _authorizeManagement(req) {
    const token = this.config.gateway?.adminToken || process.env.MYCLAW_ADMIN_TOKEN || '';
    if (!token) {
      return { status: 403, message: 'Management API disabled: configure gateway.adminToken or MYCLAW_ADMIN_TOKEN' };
    }
    const header = req.headers.authorization || '';
    if (header !== `Bearer ${token}`) {
      return { status: 401, message: 'Unauthorized management API request' };
    }
    if (isPublicHost(this.host) && !token) {
      return { status: 403, message: 'Management API requires token on non-localhost host' };
    }
    return null;
  }

  _authorizeChannelWebhook(req) {
    const channelToken = this.config.channels?.webhook?.token || process.env.MYCLAW_CHANNEL_TOKEN || '';
    const adminToken = this.config.gateway?.adminToken || process.env.MYCLAW_ADMIN_TOKEN || '';
    const accepted = [channelToken, adminToken].filter(Boolean);
    if (!accepted.length) {
      return { status: 403, message: 'Channel webhook disabled: configure channels.webhook.token or gateway.adminToken' };
    }
    const header = req.headers.authorization || '';
    if (!accepted.some(token => header === `Bearer ${token}`)) {
      return { status: 401, message: 'Unauthorized channel webhook request' };
    }
    return null;
  }

  _adminContext(source = {}) {
    return {
      session_id: source.sessionId || source.sourceSessionId || null,
      user_id: source.userId || 'gateway-admin',
      agent_id: source.agentId || this.config.agent?.name || 'myclaw',
      permissions: [
        APPROVAL_PERMISSIONS.ADMIN,
        APPROVAL_PERMISSIONS.MEMORY_WRITE,
        MEMORY_PERMISSIONS.WRITE,
      ],
      decidedBy: 'gateway-admin',
    };
  }

  _json(res, status, data) {
    res.writeHead(status, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(data, null, 2));
  }

  _readBody(req) {
    return new Promise((resolve, reject) => {
      const chunks = [];
      req.on('data', c => chunks.push(c));
      req.on('end', () => {
        try {
          resolve(JSON.parse(Buffer.concat(chunks).toString('utf-8') || '{}'));
        } catch {
          resolve({});
        }
      });
      req.on('error', reject);
    });
  }
}

function isManagementPath(pathname) {
  return pathname === '/api/approvals' ||
    pathname.startsWith('/api/approvals/') ||
    pathname === '/api/audit' ||
    pathname === '/api/audit/tail' ||
    pathname === '/api/events' ||
    pathname === '/api/memory/proposals' ||
    pathname.startsWith('/api/memory/proposals/');
}

function isPublicHost(host) {
  return ['0.0.0.0', '::', '[::]'].includes(host);
}

function parseBoolean(value) {
  return value === 'true' || value === '1' || value === '';
}

function parseLimit(value, fallback) {
  const parsed = Number.parseInt(value, 10);
  if (!Number.isFinite(parsed) || parsed <= 0) return fallback;
  return parsed;
}

function sanitizeApproval(request) {
  const data = request.toJSON ? request.toJSON() : { ...request };
  return {
    ...data,
    reason: safeText(data.reason),
    resource: safeText(data.resource),
    payloadSummary: safeText(data.payloadSummary),
  };
}

function sanitizeProposal(proposal) {
  const data = proposal.toJSON ? proposal.toJSON() : { ...proposal };
  return {
    ...data,
    title: safeText(data.title),
    content: safeText(data.content),
    reason: safeText(data.reason),
  };
}

function sanitizeAuditEvent(event) {
  const data = event.toJSON ? event.toJSON() : { ...event };
  return {
    ...data,
    subject: safeText(data.subject),
    action: safeText(data.action),
    resource: safeText(data.resource),
    reason: safeText(data.reason),
  };
}

function safeText(value) {
  return redactSecretText(String(value || ''));
}

function parseEventFilters(url) {
  const typesValue = url.searchParams.get('types') || '';
  return {
    since: url.searchParams.get('since') || null,
    types: typesValue
      ? new Set(typesValue.split(',').map(value => value.trim()).filter(Boolean))
      : null,
    limit: parseLimit(url.searchParams.get('limit'), 100),
  };
}

function matchesEventFilters(event, filters = {}) {
  const data = event.toJSON ? event.toJSON() : event;
  if (filters.types && !filters.types.has(data.type)) return false;
  if (filters.since && new Date(data.timestamp).getTime() < new Date(filters.since).getTime()) return false;
  return true;
}

function formatSseEvent(event) {
  const data = event.toJSON ? event.toJSON() : event;
  return [
    `id: ${data.id}`,
    `event: ${data.type || 'event'}`,
    `data: ${JSON.stringify(data)}`,
    '',
    '',
  ].join('\n');
}
