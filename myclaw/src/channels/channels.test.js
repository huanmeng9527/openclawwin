import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { AuditLog } from '../audit/index.js';
import { EventBus } from '../events/index.js';
import { QueryEngine } from '../engine/query.js';
import {
  ChannelRouter,
  ChannelSecurityPolicy,
  ChannelSessionRegistry,
  defaultChannelSessionRegistryPath,
  HttpWebhookBridge,
  InternalMessage,
  TestChannelBridge,
} from './index.js';
import { Gateway } from '../gateway/index.js';

function tmpConfig(extra = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'myclaw-channels-'));
  process.env.MYCLAW_HOME = path.join(root, 'home');
  return {
    gateway: {
      host: '127.0.0.1',
      port: 0,
      adminToken: extra.adminToken ?? 'admin-token',
    },
    agent: { name: 'myclaw', workspace: root, streaming: false, maxIterations: 3 },
    provider: { type: 'openai', model: 'fake', maxTokens: 2048 },
    tools: {
      enabled: extra.enabledTools || [],
      policies: extra.policies || {},
      exec: { allowedCommands: [], deniedCommands: [] },
    },
    channels: {
      enabled: extra.channelsEnabled || [],
      defaultAgentId: 'myclaw',
      defaultUserId: 'channel-user',
      webhook: {
        enabled: extra.webhookEnabled ?? false,
        token: extra.webhookToken ?? '',
      },
    },
    memory: { root: path.join(root, 'memory') },
    audit: { rotation: { enabled: true, maxSizeBytes: 1024 * 1024, maxFiles: 2 } },
    events: { maxRecentEvents: 20 },
  };
}

class FakeProvider {
  constructor(responses) {
    this.responses = responses;
    this.calls = [];
  }

  async chat(payload) {
    this.calls.push(payload);
    const message = this.responses.shift() || { role: 'assistant', content: 'done' };
    return { choices: [{ message }], usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 } };
  }
}

class FakeEngine {
  constructor(text = 'fake reply') {
    this.calls = [];
    this.auditLog = new AuditLog(tmpConfig());
    this.eventBus = new EventBus();
    this.text = text;
    this.sessions = { list: () => [] };
  }

  getToolNames() { return []; }

  async run(text, sessionId, options = {}) {
    this.calls.push({ text, sessionId, options });
    return { text: this.text, session: { id: sessionId || 'session_from_fake' }, usage: {}, iterations: 1 };
  }
}

async function withGateway(config, deps, fn) {
  const gateway = new Gateway(config, deps);
  await gateway.start();
  const { port } = gateway._server.address();
  try {
    return await fn({ gateway, baseUrl: `http://127.0.0.1:${port}` });
  } finally {
    await gateway.stop();
  }
}

async function api(baseUrl, pathname, options = {}) {
  const headers = { ...(options.headers || {}) };
  if (options.token) headers.Authorization = `Bearer ${options.token}`;
  if (options.body !== undefined) headers['Content-Type'] = 'application/json';
  const response = await fetch(`${baseUrl}${pathname}`, {
    method: options.method || 'GET',
    headers,
    body: options.body === undefined ? undefined : JSON.stringify(options.body),
  });
  const text = await response.text();
  return { status: response.status, body: text ? JSON.parse(text) : null };
}

test('InternalMessage normalizes aliases and redacts secret text', () => {
  const message = new InternalMessage({
    channel: 'test',
    messageId: 'm1',
    threadId: 'c1',
    user_id: 'u1',
    content: 'hello password=secret',
    metadata: { token: 'abc123', ok: true },
  });

  assert.equal(message.channelMessageId, 'm1');
  assert.equal(message.conversationId, 'c1');
  assert.equal(message.userId, 'u1');
  assert.match(message.text, /\[redacted\]/);
  assert.equal(message.metadata.token, '[redacted]');
});

test('TestChannelBridge receives and sends messages', async () => {
  const bridge = new TestChannelBridge({ name: 'dict' });
  const seen = [];
  bridge.onMessage(async (message) => {
    seen.push(message.text);
    await bridge.sendMessage({ conversationId: message.conversationId, text: 'reply' });
  });

  await bridge.emitMessage({ conversationId: 'c1', text: 'hello' });

  assert.deepEqual(seen, ['hello']);
  assert.equal(bridge.getSentMessages()[0].text, 'reply');
  bridge.reset();
  assert.equal(bridge.getSentMessages().length, 0);
});

test('ChannelRouter receives message, calls QueryEngine-compatible runtime, and sends reply', async () => {
  const engine = new FakeEngine('assistant reply');
  const bridge = new TestChannelBridge({ name: 'test' });
  const router = new ChannelRouter({ engine, bridge, eventBus: engine.eventBus, auditLog: engine.auditLog });
  router.attachBridge(bridge);

  const [routed] = await bridge.emitMessage({ conversationId: 'c1', userId: 'u1', text: 'hello agent' });

  assert.equal(engine.calls.length, 1);
  assert.equal(engine.calls[0].text, 'hello agent');
  assert.equal(engine.calls[0].options.laneId, 'channel:test');
  assert.equal(bridge.getSentMessages()[0].text, 'assistant reply');
  assert.equal(routed.reply.text, 'assistant reply');
});

test('ChannelRouter records channel user message through normal QueryEngine L2 path', async () => {
  const config = tmpConfig();
  const provider = new FakeProvider([{ role: 'assistant', content: 'channel answer' }]);
  const engine = new QueryEngine(config, { provider });
  await engine.init();
  const bridge = new TestChannelBridge({ name: 'test' });
  const router = new ChannelRouter({ config, engine, bridge, eventBus: engine.eventBus, auditLog: engine.auditLog });

  const routed = await router.receive({ channel: 'test', conversationId: 'c1', userId: 'u1', text: 'channel hello' }, bridge);
  const sessionId = routed.reply.metadata.sessionId;
  const records = engine.memoryRouter.session.list({ session_id: sessionId }, 20);

  assert.equal(routed.reply.text, 'channel answer');
  assert.ok(records.some(record => record.key === 'user_message' && record.content.includes('channel hello')));
});

test('ChannelRouter publishes channel events and writes audit events', async () => {
  const config = tmpConfig();
  const eventBus = new EventBus();
  const auditLog = new AuditLog(config);
  const engine = new FakeEngine('event reply');
  engine.eventBus = eventBus;
  engine.auditLog = auditLog;
  const bridge = new TestChannelBridge({ name: 'test' });
  const router = new ChannelRouter({ config, engine, bridge, eventBus, auditLog });

  await router.receive({ channel: 'test', conversationId: 'c1', text: 'hello' }, bridge);

  assert.ok(eventBus.recent(10).some(event => event.type === 'channel.message.received'));
  assert.ok(eventBus.recent(10).some(event => event.type === 'channel.message.sent'));
  assert.ok(auditLog.query({ eventType: 'channel.message.received', limit: 10 }).length >= 1);
  assert.ok(auditLog.query({ eventType: 'channel.message.sent', limit: 10 }).length >= 1);
});

test('ChannelRouter does not bypass tool policy or execute tools directly', async () => {
  const config = tmpConfig({ enabledTools: ['exec'], policies: { exec: 'deny' } });
  const provider = new FakeProvider([
    {
      role: 'assistant',
      content: '',
      tool_calls: [{ id: 'exec-1', type: 'function', function: { name: 'exec', arguments: '{"command":"echo unsafe"}' } }],
    },
    { role: 'assistant', content: 'denied through policy' },
  ]);
  const engine = new QueryEngine(config, { provider });
  await engine.init();
  const bridge = new TestChannelBridge({ name: 'test' });
  const router = new ChannelRouter({ config, engine, bridge, eventBus: engine.eventBus, auditLog: engine.auditLog });

  const routed = await router.receive({ channel: 'test', conversationId: 'c1', text: 'please exec' }, bridge);
  const denies = engine.auditLog.query({ eventType: 'tool.policy.deny', limit: 10 });
  const starts = engine.auditLog.query({ eventType: 'tool.execution.start', limit: 10 });

  assert.equal(routed.reply.text, 'denied through policy');
  assert.equal(denies.length, 1);
  assert.equal(starts.length, 0);
});

test('HttpWebhookBridge converts generic body to InternalMessage', () => {
  const bridge = new HttpWebhookBridge({ channel: 'generic', config: tmpConfig() });
  const message = bridge.messageFromBody('generic', {
    id: 'external-1',
    conversationId: 'conv-1',
    text: 'hello',
    sender: 'alice',
  });

  assert.equal(message.channel, 'generic');
  assert.equal(message.channelMessageId, 'external-1');
  assert.equal(message.conversationId, 'conv-1');
  assert.equal(message.sender, 'alice');
});

test('webhook route is disabled by default', async () => {
  const config = tmpConfig({ webhookEnabled: false, webhookToken: 'channel-token' });
  await withGateway(config, { engine: new FakeEngine('unused') }, async ({ baseUrl }) => {
    const result = await api(baseUrl, '/api/channels/webhook/test', {
      method: 'POST',
      token: 'channel-token',
      body: { text: 'hello' },
    });

    assert.equal(result.status, 404);
    assert.match(result.body.error, /disabled/);
  });
});

test('webhook route requires token when enabled', async () => {
  const config = tmpConfig({ webhookEnabled: true, webhookToken: 'channel-token' });
  await withGateway(config, { engine: new FakeEngine('reply') }, async ({ baseUrl }) => {
    const missing = await api(baseUrl, '/api/channels/webhook/test', {
      method: 'POST',
      body: { text: 'hello' },
    });
    const wrong = await api(baseUrl, '/api/channels/webhook/test', {
      method: 'POST',
      token: 'wrong',
      body: { text: 'hello' },
    });

    assert.equal(missing.status, 401);
    assert.equal(wrong.status, 401);
  });
});

test('webhook route returns JSON response and accepts channel token', async () => {
  const config = tmpConfig({ webhookEnabled: true, webhookToken: 'channel-token' });
  const engine = new FakeEngine('webhook reply');
  await withGateway(config, { engine }, async ({ baseUrl }) => {
    const result = await api(baseUrl, '/api/channels/webhook/generic', {
      method: 'POST',
      token: 'channel-token',
      body: {
        id: 'external-1',
        conversationId: 'conv-1',
        text: 'webhook hello',
        userId: 'u1',
      },
    });

    assert.equal(result.status, 200);
    assert.equal(result.body.ok, true);
    assert.equal(result.body.channel, 'generic');
    assert.equal(result.body.reply.text, 'webhook reply');
    assert.equal(engine.calls[0].text, 'webhook hello');
  });
});

test('webhook route accepts admin token as fallback authorization', async () => {
  const config = tmpConfig({ webhookEnabled: true, webhookToken: '' });
  await withGateway(config, { engine: new FakeEngine('admin reply') }, async ({ baseUrl }) => {
    const result = await api(baseUrl, '/api/channels/webhook/generic', {
      method: 'POST',
      token: 'admin-token',
      body: { text: 'admin authorized webhook' },
    });

    assert.equal(result.status, 200);
    assert.equal(result.body.reply.text, 'admin reply');
  });
});

test('ChannelSessionRegistry resolves same conversation/user to same session id', () => {
  const config = tmpConfig();
  let created = 0;
  const registry = new ChannelSessionRegistry({ config });
  const sessionManager = { create: () => ({ id: `session_${++created}` }) };
  const message = new InternalMessage({ channel: 'test', conversationId: 'conv1', userId: 'u1', text: 'hello' });

  const first = registry.resolveSession(message, { sessionManager, agent_id: 'a1' });
  const second = registry.resolveSession(message, { sessionManager, agent_id: 'a1' });

  assert.equal(first.sessionId, second.sessionId);
  assert.equal(second.messageCount, 2);
  assert.equal(created, 1);
});

test('ChannelSessionRegistry resolves different conversations to different session ids', () => {
  const config = tmpConfig();
  let created = 0;
  const registry = new ChannelSessionRegistry({ config });
  const sessionManager = { create: () => ({ id: `session_${++created}` }) };

  const first = registry.resolveSession(new InternalMessage({ channel: 'test', conversationId: 'a', userId: 'u1' }), { sessionManager });
  const second = registry.resolveSession(new InternalMessage({ channel: 'test', conversationId: 'b', userId: 'u1' }), { sessionManager });

  assert.notEqual(first.sessionId, second.sessionId);
  assert.equal(created, 2);
});

test('ChannelSessionRegistry persists, reloads, and recovers corrupt registry with backup', () => {
  const config = tmpConfig();
  const filePath = defaultChannelSessionRegistryPath(config);
  const registry = new ChannelSessionRegistry({ config, filePath });
  const mapping = registry.resolveSession(new InternalMessage({ channel: 'test', conversationId: 'conv', userId: 'u1' }), {
    sessionManager: { create: () => ({ id: 'session_persisted' }) },
  });

  const reloaded = new ChannelSessionRegistry({ config, filePath });
  assert.equal(reloaded.getMapping('test', 'conv', 'u1').sessionId, mapping.sessionId);

  fs.writeFileSync(filePath, '{ corrupt json', 'utf-8');
  const recovered = new ChannelSessionRegistry({ config, filePath });
  const backups = fs.readdirSync(path.dirname(filePath)).filter(name => name.includes('.corrupt.'));

  assert.equal(recovered.listMappings().length, 0);
  assert.ok(backups.length >= 1);
});

test('ChannelSecurityPolicy denylist, allowlist, max length, and rate limit decisions', () => {
  const denyPolicy = new ChannelSecurityPolicy({ channels: { denylist: [{ channel: 'test', userId: 'blocked' }] } });
  assert.equal(denyPolicy.check(new InternalMessage({ channel: 'test', userId: 'blocked', text: 'x' })).allowed, false);

  const allowPolicy = new ChannelSecurityPolicy({ channels: { allowlist: [{ channel: 'test', userId: 'allowed' }] } });
  assert.equal(allowPolicy.check(new InternalMessage({ channel: 'test', userId: 'other', text: 'x' })).allowed, false);
  assert.equal(allowPolicy.check(new InternalMessage({ channel: 'test', userId: 'allowed', text: 'x' })).allowed, true);

  const lengthPolicy = new ChannelSecurityPolicy({ channels: { maxMessageLength: 3 } });
  assert.equal(lengthPolicy.check(new InternalMessage({ channel: 'test', text: 'toolong' })).status, 400);

  let now = 1000;
  const ratePolicy = new ChannelSecurityPolicy({
    channels: { rateLimit: { enabled: true, windowMs: 1000, maxMessages: 1 } },
  }, { now: () => now });
  assert.equal(ratePolicy.check(new InternalMessage({ channel: 'test', conversationId: 'c', userId: 'u' })).allowed, true);
  assert.equal(ratePolicy.check(new InternalMessage({ channel: 'test', conversationId: 'c', userId: 'u' })).status, 429);
  now += 1001;
  assert.equal(ratePolicy.check(new InternalMessage({ channel: 'test', conversationId: 'c', userId: 'u' })).allowed, true);
});

test('ChannelRouter denylist blocks before QueryEngine and writes audit/event', async () => {
  const config = tmpConfig({ channelsEnabled: ['test'] });
  config.channels.denylist = [{ channel: 'test', userId: 'blocked' }];
  const engine = new FakeEngine('should not run');
  const bridge = new TestChannelBridge({ name: 'test' });
  const router = new ChannelRouter({ config, engine, bridge, eventBus: engine.eventBus, auditLog: engine.auditLog });

  const routed = await router.receive({ channel: 'test', conversationId: 'c1', userId: 'blocked', text: 'hello' }, bridge);

  assert.equal(routed.denied, true);
  assert.equal(engine.calls.length, 0);
  assert.ok(engine.eventBus.recent(20).some(event => event.type === 'channel.message.denied'));
  assert.ok(engine.auditLog.query({ eventType: 'channel.message.denied', limit: 10 }).length >= 1);
});

test('ChannelRouter allowlist and maxMessageLength block nonconforming messages', async () => {
  const config = tmpConfig({ channelsEnabled: ['test'] });
  config.channels.allowlist = [{ channel: 'test', userId: 'allowed' }];
  config.channels.maxMessageLength = 5;
  const engine = new FakeEngine('unused');
  const bridge = new TestChannelBridge({ name: 'test' });
  const router = new ChannelRouter({ config, engine, bridge, eventBus: engine.eventBus, auditLog: engine.auditLog });

  const notListed = await router.receive({ channel: 'test', conversationId: 'c1', userId: 'other', text: 'hello' }, bridge);
  const tooLong = await router.receive({ channel: 'test', conversationId: 'c1', userId: 'allowed', text: 'hello!' }, bridge);

  assert.equal(notListed.status, 403);
  assert.equal(tooLong.status, 400);
  assert.equal(engine.calls.length, 0);
});

test('ChannelRouter rate limit blocks after threshold', async () => {
  const config = tmpConfig({ channelsEnabled: ['test'] });
  config.channels.rateLimit = { enabled: true, windowMs: 60000, maxMessages: 1 };
  const engine = new FakeEngine('ok');
  const bridge = new TestChannelBridge({ name: 'test' });
  const router = new ChannelRouter({ config, engine, bridge, eventBus: engine.eventBus, auditLog: engine.auditLog });

  const first = await router.receive({ channel: 'test', conversationId: 'c1', userId: 'u1', text: 'one' }, bridge);
  const second = await router.receive({ channel: 'test', conversationId: 'c1', userId: 'u1', text: 'two' }, bridge);

  assert.equal(first.denied, undefined);
  assert.equal(second.status, 429);
  assert.equal(engine.calls.length, 1);
  assert.ok(engine.eventBus.recent(20).some(event => event.type === 'channel.rate_limit.denied'));
});

test('allowed channel message updates registry messageCount and resolved session event', async () => {
  const config = tmpConfig({ channelsEnabled: ['test'] });
  const engine = new FakeEngine('ok');
  const bridge = new TestChannelBridge({ name: 'test' });
  const registry = new ChannelSessionRegistry({ config });
  const router = new ChannelRouter({ config, engine, bridge, eventBus: engine.eventBus, auditLog: engine.auditLog, sessionRegistry: registry });

  await router.receive({ channel: 'test', conversationId: 'c1', userId: 'u1', text: 'one' }, bridge);
  await router.receive({ channel: 'test', conversationId: 'c1', userId: 'u1', text: 'two' }, bridge);

  const mapping = registry.getMapping('test', 'c1', 'u1');
  assert.equal(mapping.messageCount, 2);
  assert.ok(engine.eventBus.recent(20).some(event => event.type === 'channel.session.resolved'));
});

test('webhook allowed message reaches QueryEngine through policy and registry', async () => {
  const config = tmpConfig({ webhookEnabled: true, webhookToken: 'channel-token', channelsEnabled: ['generic'] });
  const engine = new FakeEngine('webhook allowed');
  await withGateway(config, { engine }, async ({ baseUrl }) => {
    const result = await api(baseUrl, '/api/channels/webhook/generic', {
      method: 'POST',
      token: 'channel-token',
      body: { conversationId: 'conv-secure', userId: 'u1', text: 'secure hello' },
    });

    assert.equal(result.status, 200);
    assert.equal(engine.calls.length, 1);
    assert.equal(engine.calls[0].text, 'secure hello');
    assert.equal(result.body.reply.text, 'webhook allowed');
  });
});
