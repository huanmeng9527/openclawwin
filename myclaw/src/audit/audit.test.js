import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { ApprovalBroker, APPROVAL_PERMISSIONS, APPROVAL_TYPES } from '../approval/index.js';
import { MemoryRouter } from '../memory/index.js';
import { SessionTranscriptRecorder } from '../session/transcript.js';
import { createReadTool } from '../tools/builtin.js';
import { StreamingToolExecutor } from '../tools/executor.js';
import { ToolPolicy } from '../tools/policy.js';
import { ToolRegistry, makeTool } from '../tools/registry.js';
import { AuditLog } from './index.js';

function tmpAudit() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'myclaw-audit-'));
  return { root, auditLog: new AuditLog({}, { filePath: path.join(root, 'audit.log') }) };
}

function emptyPlugins() {
  return { async runHook(_name, context) { return context; } };
}

test('AuditLog writes JSONL events', () => {
  const { auditLog } = tmpAudit();
  const event = auditLog.write({
    eventType: 'tool.policy.allow',
    sessionId: 's1',
    toolName: 'read',
    decision: 'allow',
  });
  const lines = fs.readFileSync(auditLog.filePath, 'utf-8').trim().split('\n');

  assert.equal(lines.length, 1);
  assert.equal(JSON.parse(lines[0]).id, event.id);
  assert.equal(JSON.parse(lines[0]).eventType, 'tool.policy.allow');
});

test('AuditLog.query filters by decision, toolName, and sessionId', () => {
  const { auditLog } = tmpAudit();
  auditLog.write({ eventType: 'tool.policy.allow', sessionId: 's1', toolName: 'read', decision: 'allow' });
  auditLog.write({ eventType: 'tool.policy.deny', sessionId: 's1', toolName: 'exec', decision: 'deny' });
  auditLog.write({ eventType: 'tool.policy.deny', sessionId: 's2', toolName: 'exec', decision: 'deny' });

  const results = auditLog.query({ decision: 'deny', toolName: 'exec', sessionId: 's1' });
  assert.equal(results.length, 1);
  assert.equal(results[0].sessionId, 's1');
});

test('AuditLog redacts secrets and truncates long metadata', () => {
  const { auditLog } = tmpAudit();
  auditLog.write({
    eventType: 'tool.execution.start',
    decision: 'allow',
    metadata: {
      api_key: 'super-secret',
      nested: { password: 'hidden' },
      long: 'x'.repeat(1500),
    },
  });
  const [event] = auditLog.query({ eventType: 'tool.execution.start' });

  assert.equal(event.metadata.api_key, '[redacted]');
  assert.equal(event.metadata.nested.password, '[redacted]');
  assert.match(event.metadata.long, /\[truncated at 1000 chars\]/);
});

test('approval events are written to audit log and L2 system_event still exists', () => {
  const { root, auditLog } = tmpAudit();
  const router = new MemoryRouter({ memory: { root: path.join(root, 'memory') } });
  const transcript = new SessionTranscriptRecorder(router);
  const broker = new ApprovalBroker({ transcript, auditLog, persist: false });
  const context = { session_id: 's1', user_id: 'u1', agent_id: 'a1' };

  const request = broker.submit({
    type: APPROVAL_TYPES.TOOL_CALL,
    toolName: 'exec',
    reason: 'needs approval',
  }, context);
  broker.approve(request.id, {
    ...context,
    permissions: [APPROVAL_PERMISSIONS.TOOL_CALL],
    decidedBy: 'security',
  }, 'approved');

  assert.equal(auditLog.query({ eventType: 'approval.submitted', approvalId: request.id }).length, 1);
  assert.equal(auditLog.query({ eventType: 'approval.approved', approvalId: request.id }).length, 1);
  const l2 = router.session.list({ session_id: 's1' }, 20);
  assert.equal(l2.filter(record => record.key === 'system_event').length, 2);
});

test('denied tool action writes audit event', async () => {
  const { auditLog } = tmpAudit();
  const registry = new ToolRegistry();
  registry.register(makeTool('read', 'read', { type: 'object', properties: {} }, async () => 'ok').definition, async () => 'ok');
  const executor = new StreamingToolExecutor(
    registry,
    new ToolPolicy({ tools: { enabled: ['read'], policies: { read: 'deny' } } }),
    emptyPlugins(),
    { auditLog, context: { session_id: 's1', agent_id: 'a1' } }
  );

  const [result] = await executor.executeAll([{ id: 'read-deny', type: 'function', function: { name: 'read', arguments: '{}' } }]);

  assert.equal(result.denied, true);
  assert.equal(auditLog.query({ eventType: 'tool.policy.deny', toolName: 'read', sessionId: 's1' }).length, 1);
});

test('allowed tool execution writes policy/start/success audit events', async () => {
  const { auditLog } = tmpAudit();
  const registry = new ToolRegistry();
  registry.register(makeTool('ping', 'ping', { type: 'object', properties: {} }, async () => 'pong').definition, async () => 'pong');
  const config = { tools: { enabled: ['ping'], policies: { ping: 'allow' } } };
  const executor = new StreamingToolExecutor(
    registry,
    new ToolPolicy(config),
    emptyPlugins(),
    { auditLog, context: { session_id: 's1', agent_id: 'a1' } }
  );

  const [result] = await executor.executeAll([{ id: 'ping-1', type: 'function', function: { name: 'ping', arguments: '{}' } }]);

  assert.equal(result.denied, false);
  assert.equal(auditLog.query({ eventType: 'tool.policy.allow', toolName: 'ping', sessionId: 's1' }).length, 1);
  assert.equal(auditLog.query({ eventType: 'tool.execution.start', toolName: 'ping', sessionId: 's1' }).length, 1);
  assert.equal(auditLog.query({ eventType: 'tool.execution.success', toolName: 'ping', sessionId: 's1' }).length, 1);
});

test('workspace sandbox deny writes audit event', async () => {
  const { root, auditLog } = tmpAudit();
  const workspace = path.join(root, 'workspace');
  const outside = path.join(root, 'outside.txt');
  fs.mkdirSync(workspace, { recursive: true });
  fs.writeFileSync(outside, 'outside', 'utf-8');
  const config = { agent: { workspace }, tools: { enabled: ['read'], policies: { read: 'allow' } } };
  const read = createReadTool(config);
  const registry = new ToolRegistry();
  registry.register(read.definition, read.handler);
  const executor = new StreamingToolExecutor(
    registry,
    new ToolPolicy(config),
    emptyPlugins(),
    { auditLog, context: { session_id: 's1', agent_id: 'a1' } }
  );

  const [result] = await executor.executeAll([{ id: 'read-outside', type: 'function', function: { name: 'read', arguments: JSON.stringify({ path: outside }) } }]);

  assert.match(result.result, /Workspace sandbox denied path/);
  assert.equal(auditLog.query({ eventType: 'workspace.sandbox.deny', toolName: 'read', sessionId: 's1' }).length, 1);
});

test('memory write deny writes audit event', () => {
  const { root, auditLog } = tmpAudit();
  const router = new MemoryRouter({ memory: { root: path.join(root, 'memory') } }, { auditLog });

  assert.throws(() => router.write({ layer: 'semantic', content: 'blocked' }, 'semantic', { session_id: 's1' }), /semantic memory operation/);
  const events = auditLog.query({ eventType: 'memory.write.deny', sessionId: 's1' });
  assert.equal(events.length, 1);
  assert.equal(events[0].decision, 'deny');
});

test('memory write/delete/reindex allow writes audit events', () => {
  const { root, auditLog } = tmpAudit();
  const router = new MemoryRouter({ memory: { root: path.join(root, 'memory') } }, { auditLog });
  const context = { session_id: 's1', permissions: ['memory.write', 'memory.delete', 'memory.reindex'] };

  const saved = router.write({ id: 'sem-audit', layer: 'semantic', content: 'audited' }, 'semantic', context);
  router.delete(saved.id, context);
  router.reindex('semantic', context);

  assert.equal(auditLog.query({ eventType: 'memory.write.allow', sessionId: 's1' }).length, 1);
  assert.equal(auditLog.query({ eventType: 'memory.delete.allow', sessionId: 's1' }).length, 1);
  assert.equal(auditLog.query({ eventType: 'memory.reindex.allow', sessionId: 's1' }).length, 1);
});
