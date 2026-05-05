import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { ApprovalBroker, APPROVAL_PERMISSIONS, APPROVAL_STATUS, APPROVAL_TYPES } from '../approval/index.js';
import { AuditLog } from '../audit/index.js';
import { MarkdownStore } from '../memory/markdownStore.js';
import { MemoryProposalStore } from '../memory/proposals.js';
import { MemoryRouter, MEMORY_PERMISSIONS } from '../memory/index.js';
import { SessionManager } from '../session/index.js';
import { atomicWriteJson, atomicWriteText, readJsonSafe } from './index.js';

function tmpRoot(prefix = 'myclaw-storage-') {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

function corruptBackups(filePath) {
  const dir = path.dirname(filePath);
  const name = path.basename(filePath);
  return fs.readdirSync(dir).filter(file => file.startsWith(`${name}.corrupt.`));
}

function withRenameFailure(fn) {
  const original = fs.renameSync;
  fs.renameSync = () => {
    throw new Error('simulated rename failure');
  };
  try {
    return fn();
  } finally {
    fs.renameSync = original;
  }
}

test('atomicWriteJson failure does not replace existing JSON with half-file', () => {
  const filePath = path.join(tmpRoot(), 'data.json');
  atomicWriteJson(filePath, { ok: true });
  const before = fs.readFileSync(filePath, 'utf-8');

  assert.throws(() => withRenameFailure(() => atomicWriteJson(filePath, { ok: false })), /simulated rename failure/);

  assert.equal(fs.readFileSync(filePath, 'utf-8'), before);
  assert.deepEqual(JSON.parse(before), { ok: true });
});

test('readJsonSafe backs up corrupt JSON and returns default value', () => {
  const filePath = path.join(tmpRoot(), 'bad.json');
  fs.writeFileSync(filePath, '{bad json', 'utf-8');

  const data = readJsonSafe(filePath, { recovered: true });

  assert.deepEqual(data, { recovered: true });
  assert.equal(fs.existsSync(filePath), false);
  assert.equal(corruptBackups(filePath).length, 1);
});

test('ApprovalBroker recovers from corrupt approvals file and keeps backup', () => {
  const root = tmpRoot();
  const filePath = path.join(root, 'approvals.json');
  fs.writeFileSync(filePath, '{broken', 'utf-8');

  const broker = new ApprovalBroker({ filePath });

  assert.equal(broker.list().length, 0);
  assert.equal(corruptBackups(filePath).length, 1);
});

test('MemoryProposalStore recovers from corrupt proposals file and keeps backup', () => {
  const root = tmpRoot();
  const filePath = path.join(root, 'proposals.json');
  fs.writeFileSync(filePath, '{broken', 'utf-8');

  const store = new MemoryProposalStore({ filePath, memoryRouter: new MemoryRouter({ memory: { root: path.join(root, 'memory') } }) });

  assert.equal(store.listProposals().length, 0);
  assert.equal(corruptBackups(filePath).length, 1);
});

test('ApprovalBroker approve and deny decisions are idempotent', () => {
  const broker = new ApprovalBroker({ filePath: path.join(tmpRoot(), 'approvals.json') });
  const request = broker.submit({ type: APPROVAL_TYPES.TOOL_CALL, toolName: 'exec', reason: 'review' });
  const context = { permissions: [APPROVAL_PERMISSIONS.TOOL_CALL], decidedBy: 'tester' };

  const approved = broker.approve(request.id, context, 'approved once');
  const deniedAfterApproval = broker.deny(request.id, context, 'deny later');

  assert.equal(approved.status, APPROVAL_STATUS.APPROVED);
  assert.equal(deniedAfterApproval.status, APPROVAL_STATUS.APPROVED);
  assert.equal(deniedAfterApproval.decision, 'approved once');
});

test('MemoryProposalStore writeApprovedProposal is idempotent', () => {
  const root = tmpRoot();
  const auditLog = new AuditLog({}, { filePath: path.join(root, 'audit.log') });
  const router = new MemoryRouter({ memory: { root: path.join(root, 'memory') } }, { auditLog });
  const store = new MemoryProposalStore({ filePath: path.join(root, 'proposals.json'), memoryRouter: router, auditLog });
  const proposal = store.createProposal({
    type: 'semantic_fact',
    content: 'Remember: project fact should be written once.',
    confidence: 0.9,
    reason: 'test',
  });
  store.approveProposal(proposal.id, { permissions: [MEMORY_PERMISSIONS.WRITE] }, 'ok');

  const first = store.writeApprovedProposal(proposal.id, { permissions: [MEMORY_PERMISSIONS.WRITE] });
  const second = store.writeApprovedProposal(proposal.id, { permissions: [MEMORY_PERMISSIONS.WRITE] });

  assert.equal(first.targetMemoryId, second.targetMemoryId);
  assert.equal(router.semantic.list({}, 100).filter(record => record.metadata.proposalId === proposal.id).length, 1);
});

test('AuditLog rotates current JSONL file when size threshold is exceeded', () => {
  const root = tmpRoot();
  const auditLog = new AuditLog({}, {
    filePath: path.join(root, 'audit.log'),
    rotation: { enabled: true, maxSizeBytes: 180, maxFiles: 2 },
  });

  for (let index = 0; index < 5; index++) {
    auditLog.write({
      eventType: 'storage.rotation',
      decision: 'allow',
      reason: `event ${index} ${'x'.repeat(80)}`,
    });
  }

  assert.equal(fs.existsSync(path.join(root, 'audit.log')), true);
  assert.equal(fs.existsSync(path.join(root, 'audit.log.1')), true);
  assert.ok(auditLog.query({ eventType: 'storage.rotation' }).length >= 1);
});

test('AuditLog sanitizer still redacts secret metadata after safe append', () => {
  const auditLog = new AuditLog({}, { filePath: path.join(tmpRoot(), 'audit.log') });
  auditLog.write({
    eventType: 'storage.sanitize',
    decision: 'allow',
    metadata: { api_key: 'secret-value', nested: { password: 'pw' } },
  });

  const [event] = auditLog.query({ eventType: 'storage.sanitize' });

  assert.equal(event.metadata.api_key, '[redacted]');
  assert.equal(event.metadata.nested.password, '[redacted]');
});

test('SessionManager atomic save failure leaves previous session JSON intact', () => {
  const root = tmpRoot();
  const manager = new SessionManager(path.join(root, 'sessions'));
  const session = manager.create('atomic session');
  const filePath = path.join(manager.dir, `${session.id}.json`);
  const before = fs.readFileSync(filePath, 'utf-8');
  session.addMessage('user', 'new message');

  assert.throws(() => withRenameFailure(() => manager.save(session)), /simulated rename failure/);

  assert.equal(fs.readFileSync(filePath, 'utf-8'), before);
  assert.equal(JSON.parse(before).messages.length, 0);
});

test('MarkdownStore atomic write failure does not destroy existing canonical file', () => {
  const root = tmpRoot();
  const store = new MarkdownStore(root, 'semantic');
  store.put({
    id: 'md-original',
    layer: 'semantic',
    content: 'Remember: original markdown fact remains safe.',
    metadata: { category: 'facts' },
  });
  const filePath = path.join(root, 'semantic', 'facts.md');
  const before = fs.readFileSync(filePath, 'utf-8');

  assert.throws(() => withRenameFailure(() => store.put({
    id: 'md-original',
    layer: 'semantic',
    content: 'Remember: updated fact should fail.',
    metadata: { category: 'facts' },
  })), /simulated rename failure/);

  assert.equal(fs.readFileSync(filePath, 'utf-8'), before);
});

test('atomicWriteText failure removes temp file and keeps destination', () => {
  const root = tmpRoot();
  const filePath = path.join(root, 'note.md');
  atomicWriteText(filePath, 'original');

  assert.throws(() => withRenameFailure(() => atomicWriteText(filePath, 'updated')), /simulated rename failure/);

  assert.equal(fs.readFileSync(filePath, 'utf-8'), 'original');
  assert.equal(fs.readdirSync(root).filter(file => file.includes('.tmp.')).length, 0);
});
