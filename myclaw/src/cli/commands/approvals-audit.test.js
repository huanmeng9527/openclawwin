import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { ApprovalBroker, APPROVAL_TYPES } from '../../approval/index.js';
import { AuditLog } from '../../audit/index.js';
import { MemoryRouter } from '../../memory/index.js';
import {
  approvalsDenyCommand,
  approvalsListCommand,
  approvalsShowCommand,
} from './approvals.js';
import { auditQueryCommand, auditTailCommand } from './audit.js';

function withTempHome(fn) {
  const previous = process.env.MYCLAW_HOME;
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'myclaw-cli-'));
  process.env.MYCLAW_HOME = home;
  try {
    return fn(home);
  } finally {
    if (previous === undefined) delete process.env.MYCLAW_HOME;
    else process.env.MYCLAW_HOME = previous;
  }
}

function captureOutput(fn) {
  const previous = console.log;
  const lines = [];
  console.log = (...args) => lines.push(args.join(' '));
  try {
    fn();
  } finally {
    console.log = previous;
  }
  return lines.join('\n');
}

function submitApproval(data = {}) {
  const broker = new ApprovalBroker();
  return broker.submit({
    type: APPROVAL_TYPES.TOOL_CALL,
    toolName: 'exec',
    subject: 'exec',
    action: 'execute',
    reason: 'needs review',
    sessionId: 'session-1',
    userId: 'user-1',
    agentId: 'agent-1',
    ...data,
  }, {
    session_id: data.sessionId || 'session-1',
    user_id: data.userId || 'user-1',
    agent_id: data.agentId || 'agent-1',
  });
}

test('approvals list shows pending request', () => withTempHome(() => {
  const request = submitApproval();

  const output = captureOutput(() => approvalsListCommand({}));

  assert.match(output, new RegExp(request.id));
  assert.match(output, /pending/);
  assert.match(output, /exec/);
}));

test('approvals show redacts payloadSummary secret', () => withTempHome(() => {
  const request = submitApproval({ payloadSummary: 'api_key=abc123 password=secret-value' });

  const output = captureOutput(() => approvalsShowCommand(request.id));

  assert.match(output, /\[redacted\]/);
  assert.doesNotMatch(output, /abc123/);
  assert.doesNotMatch(output, /secret-value/);
}));

test('approvals approve requires broker permission', () => withTempHome(() => {
  const broker = new ApprovalBroker();
  const request = broker.submit({ type: APPROVAL_TYPES.TOOL_CALL, toolName: 'exec', reason: 'check permission' });

  assert.throws(() => broker.approve(request.id, { permissions: [] }, 'no permission'), /requires one of/);
}));

test('approvals deny writes audit event', () => withTempHome(() => {
  const request = submitApproval({ reason: 'deny me' });

  const output = captureOutput(() => approvalsDenyCommand(request.id, { reason: 'no thanks' }));
  const auditEvents = new AuditLog({}).query({ eventType: 'approval.denied', approvalId: request.id });
  const l2Events = new MemoryRouter({}).session.list({ session_id: 'session-1' }, 20);

  assert.match(output, /denied/);
  assert.equal(auditEvents.length, 1);
  assert.equal(auditEvents[0].decision, 'rejected');
  assert.ok(l2Events.some(record => record.content.includes('approval.denied')));
}));

test('approval persistence survives broker reload', () => withTempHome(() => {
  const request = submitApproval({ toolName: 'write' });
  const reloaded = new ApprovalBroker();

  assert.equal(reloaded.get(request.id).toolName, 'write');
  assert.equal(reloaded.listPending().length, 1);
}));

test('audit tail returns recent events', () => withTempHome(() => {
  const auditLog = new AuditLog({});
  auditLog.write({ timestamp: '2026-01-01T00:00:00.000Z', eventType: 'old.event', decision: 'allow' });
  auditLog.write({ timestamp: '2026-01-02T00:00:00.000Z', eventType: 'new.event', decision: 'deny' });

  const output = captureOutput(() => auditTailCommand({ lines: '1' }));

  assert.match(output, /new\.event/);
  assert.doesNotMatch(output, /old\.event/);
}));

test('audit query filters by decision, toolName, sessionId, and approvalId', () => withTempHome(() => {
  const auditLog = new AuditLog({});
  auditLog.write({
    eventType: 'tool.policy.deny',
    decision: 'deny',
    toolName: 'exec',
    sessionId: 's1',
    approvalId: 'appr_1',
  });
  auditLog.write({
    eventType: 'tool.policy.allow',
    decision: 'allow',
    toolName: 'read',
    sessionId: 's2',
    approvalId: 'appr_2',
  });

  const output = captureOutput(() => auditQueryCommand({
    decision: 'deny',
    tool: 'exec',
    session: 's1',
    approval: 'appr_1',
  }));

  assert.match(output, /tool\.policy\.deny/);
  assert.match(output, /appr_1/);
  assert.doesNotMatch(output, /tool\.policy\.allow/);
}));

test('CLI command handlers work with temporary MYCLAW_HOME', () => withTempHome(home => {
  const auditLog = new AuditLog({});
  auditLog.write({ eventType: 'cli.smoke', decision: 'allow', reason: 'ok' });
  const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');
  const result = spawnSync(process.execPath, [path.join(repoRoot, 'bin', 'myclaw.js'), 'audit', 'tail', '--lines', '5'], {
    cwd: repoRoot,
    env: { ...process.env, MYCLAW_HOME: home },
    encoding: 'utf-8',
  });

  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /cli\.smoke/);
}));
