import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { APPROVAL_TYPES } from '../approval/index.js';
import { Gateway } from './index.js';

function tmpConfig(extra = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'myclaw-gateway-'));
  process.env.MYCLAW_HOME = path.join(root, 'home');
  return {
    gateway: {
      host: '127.0.0.1',
      port: 0,
      adminToken: extra.adminToken ?? 'test-token',
    },
    agent: { name: 'myclaw', workspace: root, streaming: false, maxIterations: 2 },
    provider: { type: 'openai', model: 'fake', maxTokens: 2048 },
    tools: { enabled: [], policies: {} },
    memory: { root: path.join(root, 'memory') },
    audit: { rotation: { enabled: true, maxSizeBytes: 1024 * 1024, maxFiles: 2 } },
  };
}

async function withGateway(config, fn) {
  const gateway = new Gateway(config);
  await gateway.start();
  const { port } = gateway._server.address();
  const baseUrl = `http://127.0.0.1:${port}`;
  try {
    return await fn({ gateway, baseUrl });
  } finally {
    await new Promise(resolve => gateway._server.close(resolve));
  }
}

async function api(baseUrl, path, options = {}) {
  const headers = { ...(options.headers || {}) };
  if (options.token !== false) headers.Authorization = `Bearer ${options.token || 'test-token'}`;
  if (options.body !== undefined) headers['Content-Type'] = 'application/json';
  const response = await fetch(`${baseUrl}${path}`, {
    method: options.method || 'GET',
    headers,
    body: options.body === undefined ? undefined : JSON.stringify(options.body),
  });
  const text = await response.text();
  return {
    status: response.status,
    body: text ? JSON.parse(text) : null,
  };
}

function createApproval(gateway, data = {}) {
  return gateway.engine.approvalBroker.submit({
    type: APPROVAL_TYPES.TOOL_CALL,
    toolName: 'exec',
    subject: 'exec',
    action: 'execute',
    reason: 'api_key=should-redact',
    payloadSummary: 'password=hidden',
    sessionId: 's1',
    userId: 'u1',
    agentId: 'a1',
    ...data,
  }, { session_id: 's1', user_id: 'u1', agent_id: 'a1' });
}

function createProposal(gateway, data = {}) {
  return gateway.engine.memoryProposals.createProposal({
    type: 'preference',
    content: 'Remember: user preference is concise responses.',
    title: 'Candidate preference',
    tags: ['proposal', 'preference'],
    confidence: 0.9,
    reason: 'stable preference',
    sourceSessionId: 's1',
    sourceSummaryId: 'session_summary:s1',
    targetHint: 'preferences',
    ...data,
  }, { session_id: 's1', user_id: 'u1', agent_id: 'a1' });
}

test('gateway health and status remain available without admin token', async () => {
  await withGateway(tmpConfig({ adminToken: '' }), async ({ baseUrl }) => {
    const health = await api(baseUrl, '/api/health', { token: false });
    const status = await api(baseUrl, '/api/status', { token: false });

    assert.equal(health.status, 200);
    assert.equal(health.body.status, 'ok');
    assert.equal(status.status, 200);
    assert.equal(status.body.status, 'running');
  });
});

test('management API is disabled when no admin token is configured', async () => {
  await withGateway(tmpConfig({ adminToken: '' }), async ({ baseUrl }) => {
    const result = await api(baseUrl, '/api/audit', { token: false });

    assert.equal(result.status, 403);
    assert.match(result.body.error, /Management API disabled/);
  });
});

test('approval list/show API requires token and redacts payload summary', async () => {
  await withGateway(tmpConfig(), async ({ gateway, baseUrl }) => {
    const request = createApproval(gateway);
    const unauthorized = await api(baseUrl, '/api/approvals', { token: false });
    const list = await api(baseUrl, '/api/approvals?all=true');
    const show = await api(baseUrl, `/api/approvals/${request.id}`);

    assert.equal(unauthorized.status, 401);
    assert.equal(list.status, 200);
    assert.equal(list.body.approvals.length, 1);
    assert.equal(show.status, 200);
    assert.match(show.body.payloadSummary, /\[redacted\]/);
    assert.doesNotMatch(show.body.payloadSummary, /hidden/);
  });
});

test('approval approve and deny API changes decision only after token auth', async () => {
  await withGateway(tmpConfig(), async ({ gateway, baseUrl }) => {
    const request = createApproval(gateway);
    const noToken = await api(baseUrl, `/api/approvals/${request.id}/approve`, {
      method: 'POST',
      token: false,
      body: { reason: 'no auth' },
    });
    const approved = await api(baseUrl, `/api/approvals/${request.id}/approve`, {
      method: 'POST',
      body: { reason: 'reviewed' },
    });
    const deniedAfterApproval = await api(baseUrl, `/api/approvals/${request.id}/deny`, {
      method: 'POST',
      body: { reason: 'too late' },
    });

    assert.equal(noToken.status, 401);
    assert.equal(gateway.engine.approvalBroker.get(request.id).status, 'approved');
    assert.equal(approved.body.status, 'approved');
    assert.equal(deniedAfterApproval.body.status, 'approved');
  });
});

test('audit query and tail API require token and return sanitized events', async () => {
  await withGateway(tmpConfig(), async ({ gateway, baseUrl }) => {
    gateway.engine.auditLog.write({
      eventType: 'tool.policy.deny',
      decision: 'deny',
      toolName: 'exec',
      sessionId: 's1',
      approvalId: 'appr_1',
      reason: 'password=secret',
    });

    const noToken = await api(baseUrl, '/api/audit/tail?lines=1', { token: false });
    const query = await api(baseUrl, '/api/audit?decision=deny&tool=exec&session=s1&approval=appr_1');
    const tail = await api(baseUrl, '/api/audit/tail?lines=1');

    assert.equal(noToken.status, 401);
    assert.equal(query.status, 200);
    assert.equal(query.body.events.length, 1);
    assert.match(query.body.events[0].reason, /\[redacted\]/);
    assert.equal(tail.body.events.length, 1);
  });
});

test('memory proposal list/show API requires token', async () => {
  await withGateway(tmpConfig(), async ({ gateway, baseUrl }) => {
    const proposal = createProposal(gateway);

    const noToken = await api(baseUrl, '/api/memory/proposals', { token: false });
    const list = await api(baseUrl, '/api/memory/proposals?status=pending&type=preference&session=s1');
    const show = await api(baseUrl, `/api/memory/proposals/${proposal.id}`);

    assert.equal(noToken.status, 401);
    assert.equal(list.status, 200);
    assert.equal(list.body.proposals.length, 1);
    assert.equal(show.status, 200);
    assert.equal(show.body.id, proposal.id);
  });
});

test('memory proposal approve, reject, and write API require token and use proposal lifecycle', async () => {
  await withGateway(tmpConfig(), async ({ gateway, baseUrl }) => {
    const toWrite = createProposal(gateway, { content: 'Remember: stable preference from gateway write.' });
    const toReject = createProposal(gateway, {
      content: 'Remember: rejected gateway proposal.',
      sourceSummaryId: 'session_summary:s2',
    });

    const unauthorized = await api(baseUrl, `/api/memory/proposals/${toWrite.id}/approve`, {
      method: 'POST',
      token: false,
      body: { reason: 'no auth' },
    });
    const approved = await api(baseUrl, `/api/memory/proposals/${toWrite.id}/approve`, {
      method: 'POST',
      body: { reason: 'stable' },
    });
    const written = await api(baseUrl, `/api/memory/proposals/${toWrite.id}/write`, { method: 'POST', body: {} });
    const rejected = await api(baseUrl, `/api/memory/proposals/${toReject.id}/reject`, {
      method: 'POST',
      body: { reason: 'temporary' },
    });

    assert.equal(unauthorized.status, 401);
    assert.equal(approved.body.status, 'approved');
    assert.equal(written.body.status, 'written');
    assert.ok(written.body.targetMemoryId);
    assert.equal(rejected.body.status, 'rejected');
    assert.equal(gateway.engine.memoryRouter.semantic.list({}, 100).filter(record => record.metadata.proposalId === toWrite.id).length, 1);
    assert.equal(gateway.engine.memoryRouter.semantic.list({}, 100).filter(record => record.metadata.proposalId === toReject.id).length, 0);
  });
});
