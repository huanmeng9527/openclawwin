import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { ApprovalBroker, APPROVAL_PERMISSIONS, APPROVAL_TYPES } from '../approval/index.js';
import { AuditLog } from '../audit/index.js';
import { SessionCompactor } from '../compaction/index.js';
import { Gateway } from '../gateway/index.js';
import { MemoryRecord, MemoryRouter, MemoryProposalStore, MEMORY_PERMISSIONS } from '../memory/index.js';
import { ToolPolicy } from '../tools/policy.js';
import { ToolRegistry } from '../tools/registry.js';
import { StreamingToolExecutor } from '../tools/executor.js';
import { EventBus } from './index.js';

function tmpRoot(prefix = 'myclaw-events-') {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

function tmpConfig(extra = {}) {
  const root = tmpRoot();
  process.env.MYCLAW_HOME = path.join(root, 'home');
  return {
    gateway: {
      host: '127.0.0.1',
      port: 0,
      adminToken: extra.adminToken ?? 'test-token',
    },
    agent: { name: 'myclaw', workspace: root, streaming: false, maxIterations: 1 },
    provider: { type: 'openai', model: 'fake', maxTokens: 2048 },
    tools: { enabled: [], policies: {}, exec: { allowedCommands: [], deniedCommands: [] } },
    memory: { root: path.join(root, 'memory'), proposals: { enabled: true, minConfidence: 0.1 } },
    audit: { rotation: { enabled: true, maxSizeBytes: 1024 * 1024, maxFiles: 2 } },
    events: { maxRecentEvents: 10 },
  };
}

async function withGateway(config, fn) {
  const gateway = new Gateway(config);
  await gateway.start();
  const { port } = gateway._server.address();
  try {
    return await fn({ gateway, baseUrl: `http://127.0.0.1:${port}` });
  } finally {
    await gateway.stop();
  }
}

async function request(pathname, options = {}) {
  const response = await fetch(pathname, {
    method: options.method || 'GET',
    headers: options.headers || {},
  });
  const text = await response.text();
  return { status: response.status, headers: response.headers, body: text };
}

function readSseChunk(url, headers = {}, expectedText = '\n\n') {
  return new Promise((resolve, reject) => {
    let settled = false;
    const req = http.get(url, { headers }, (res) => {
      let body = '';
      res.on('data', (chunk) => {
        body += chunk.toString('utf-8');
        if (!settled && body.includes(expectedText)) {
          settled = true;
          req.destroy();
          resolve({ status: res.statusCode, headers: res.headers, body });
        }
      });
      res.on('end', () => {
        if (!settled) {
          settled = true;
          resolve({ status: res.statusCode, headers: res.headers, body });
        }
      });
    });
    req.on('error', (err) => {
      if (settled && err.code === 'ECONNRESET') return;
      reject(err);
    });
  });
}

function delay(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

test('EventBus publish, subscribe, recent, and clear work with ring buffer', () => {
  const bus = new EventBus({ maxRecentEvents: 2 });
  const seen = [];
  const unsubscribe = bus.subscribe(event => seen.push(event.type));

  bus.publish({ type: 'one' });
  bus.publish({ type: 'two' });
  bus.publish({ type: 'three' });
  unsubscribe();
  bus.publish({ type: 'four' });

  assert.deepEqual(seen, ['one', 'two', 'three']);
  assert.deepEqual(bus.recent(10).map(event => event.type), ['three', 'four']);
  assert.equal(bus.listenerCount(), 0);
  bus.clear();
  assert.equal(bus.recent(10).length, 0);
});

test('EventBus metadata and summaries redact secrets', () => {
  const bus = new EventBus();
  const event = bus.publish({
    type: 'secret.test',
    summary: 'password=supersecret',
    metadata: {
      token: 'abc123',
      nested: { note: 'api_key=hidden' },
    },
  });

  assert.match(event.summary, /\[redacted\]/);
  assert.equal(event.metadata.token, '[redacted]');
  assert.match(event.metadata.nested.note, /\[redacted\]/);
  assert.doesNotMatch(JSON.stringify(event), /supersecret|abc123|hidden/);
});

test('ApprovalBroker publishes approval lifecycle events', () => {
  const bus = new EventBus();
  const broker = new ApprovalBroker({ persist: false, eventBus: bus });

  const request = broker.submit({
    type: APPROVAL_TYPES.TOOL_CALL,
    toolName: 'exec',
    action: 'execute',
    reason: 'requires confirmation',
  }, { session_id: 's1', user_id: 'u1', agent_id: 'a1' });
  broker.approve(request.id, {
    permissions: [APPROVAL_PERMISSIONS.TOOL_CALL],
    decidedBy: 'tester',
  }, 'approved');

  assert.deepEqual(bus.recent(10).map(event => event.type), ['approval.submitted', 'approval.approved']);
  assert.equal(bus.recent(1)[0].approvalId, request.id);
});

test('MemoryProposalStore publishes proposal lifecycle events', () => {
  const config = tmpConfig();
  const bus = new EventBus();
  const store = new MemoryProposalStore({ config, eventBus: bus });

  const proposal = store.createProposal({
    type: 'preference',
    content: 'Remember: user prefers concise answers.',
    confidence: 0.9,
    sourceSessionId: 's1',
  }, { session_id: 's1', user_id: 'u1', agent_id: 'a1' });
  store.approveProposal(proposal.id, {
    permissions: [MEMORY_PERMISSIONS.WRITE],
    user_id: 'u1',
    agent_id: 'a1',
  }, 'stable');
  store.rejectProposal(store.createProposal({
    type: 'decision',
    content: 'Decision: skip temporary branch.',
    confidence: 0.9,
    sourceSessionId: 's1',
  }).id, {
    permissions: [MEMORY_PERMISSIONS.WRITE],
  }, 'temporary');

  assert.ok(bus.recent(10).some(event => event.type === 'memory.proposal.created'));
  assert.ok(bus.recent(10).some(event => event.type === 'memory.proposal.approved' && event.proposalId === proposal.id));
  assert.ok(bus.recent(10).some(event => event.type === 'memory.proposal.rejected'));
});

test('AuditLog publishes audit.event notifications', () => {
  const config = tmpConfig();
  const bus = new EventBus();
  const auditLog = new AuditLog(config, { eventBus: bus });

  auditLog.write({
    eventType: 'tool.policy.deny',
    toolName: 'exec',
    decision: 'deny',
    reason: 'password=secret',
  });

  const event = bus.recent(1)[0];
  assert.equal(event.type, 'audit.event');
  assert.equal(event.toolName, 'exec');
  assert.match(event.summary, /\[redacted\]/);
});

test('SessionCompactor publishes session.compacted events', () => {
  const config = tmpConfig();
  const bus = new EventBus();
  const memoryRouter = new MemoryRouter(config);
  const compactor = new SessionCompactor(memoryRouter, { config, eventBus: bus });
  const context = { session_id: 's1', user_id: 'u1', agent_id: 'a1' };

  for (let index = 0; index < 4; index++) {
    memoryRouter.write(new MemoryRecord({
      layer: 'session',
      session_id: 's1',
      agent_id: 'a1',
      user_id: 'u1',
      key: 'user_message',
      title: 'User message',
      content: `message ${index}`,
      created_at: new Date(1000 + index).toISOString(),
      updated_at: new Date(1000 + index).toISOString(),
    }), 'session', context);
  }

  const summary = compactor.compactSession('s1', context, {
    maxEventsBeforeCompact: 1,
    keepRecentEvents: 0,
  });

  assert.ok(summary);
  assert.ok(bus.recent(10).some(event => event.type === 'session.compacted' && event.sessionId === 's1'));
});

test('StreamingToolExecutor publishes tool policy deny and ask events', async () => {
  const registry = new ToolRegistry();
  const bus = new EventBus();
  const toolCall = {
    id: 'call_1',
    function: { name: 'exec', arguments: JSON.stringify({ command: 'echo hi' }) },
  };

  const denyExecutor = new StreamingToolExecutor(
    registry,
    new ToolPolicy({ tools: { enabled: ['exec'], policies: { exec: 'deny' } } }),
    null,
    { eventBus: bus, context: { session_id: 's1', agent_id: 'a1' } }
  );
  await denyExecutor.executeAll([toolCall]);

  const askExecutor = new StreamingToolExecutor(
    registry,
    new ToolPolicy({ tools: { enabled: ['exec'], policies: { exec: 'ask' } } }),
    null,
    { eventBus: bus, context: { session_id: 's1', agent_id: 'a1' } }
  );
  await askExecutor.executeAll([{ ...toolCall, id: 'call_2' }]);

  assert.ok(bus.recent(10).some(event => event.type === 'tool.policy.deny'));
  assert.ok(bus.recent(10).some(event => event.type === 'tool.policy.ask'));
});

test('Gateway /api/events requires token and returns SSE headers', async () => {
  await withGateway(tmpConfig(), async ({ baseUrl }) => {
    const unauthorized = await request(`${baseUrl}/api/events`);
    const sse = await readSseChunk(`${baseUrl}/api/events`, { Authorization: 'Bearer test-token' });

    assert.equal(unauthorized.status, 401);
    assert.equal(sse.status, 200);
    assert.match(sse.headers['content-type'], /text\/event-stream/);
  });
});

test('Gateway /api/events sends recent events on connect and filters by type', async () => {
  await withGateway(tmpConfig(), async ({ gateway, baseUrl }) => {
    gateway.engine.eventBus.publish({ type: 'approval.submitted', approvalId: 'appr_1', summary: 'pending' });
    gateway.engine.eventBus.publish({ type: 'memory.proposal.created', proposalId: 'proposal_1', summary: 'candidate' });

    const sse = await readSseChunk(
      `${baseUrl}/api/events?types=memory.proposal.created&limit=5`,
      { Authorization: 'Bearer test-token' },
      'memory.proposal.created'
    );

    assert.match(sse.body, /event: memory\.proposal\.created/);
    assert.doesNotMatch(sse.body, /approval\.submitted/);
  });
});

test('Gateway /api/events removes listener on disconnect', async () => {
  await withGateway(tmpConfig(), async ({ gateway, baseUrl }) => {
    await new Promise((resolve, reject) => {
      const req = http.get(`${baseUrl}/api/events`, {
        headers: { Authorization: 'Bearer test-token' },
      }, async (res) => {
        await delay(20);
        assert.equal(gateway.engine.eventBus.listenerCount(), 1);
        res.destroy();
        req.destroy();
        await delay(30);
        assert.equal(gateway.engine.eventBus.listenerCount(), 0);
        resolve();
      });
      req.on('error', (err) => {
        if (err.code === 'ECONNRESET') return;
        reject(err);
      });
    });
  });
});
