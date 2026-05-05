import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { ApprovalBroker, APPROVAL_PERMISSIONS, APPROVAL_STATUS, APPROVAL_TYPES, ApprovalPermissionError } from './index.js';
import { MemoryRouter } from '../memory/index.js';
import { SessionTranscriptRecorder } from '../session/transcript.js';
import { createExecTool } from '../tools/builtin.js';
import { StreamingToolExecutor } from '../tools/executor.js';
import { PermissionRules } from '../tools/permissions.js';
import { ToolPolicy } from '../tools/policy.js';
import { ToolRegistry, makeTool } from '../tools/registry.js';

function tmpWorkspace() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'myclaw-approval-'));
  const workspace = path.join(root, 'workspace');
  fs.mkdirSync(workspace, { recursive: true });
  return { root, workspace };
}

function emptyPlugins() {
  return { async runHook(_name, context) { return context; } };
}

function makeBroker(options = {}) {
  return new ApprovalBroker({ persist: false, ...options });
}

function makeExecutor({ config, registry, broker, mode = 'manual', transcript = null, session = { id: 's1' } }) {
  return new StreamingToolExecutor(
    registry,
    new ToolPolicy(config),
    emptyPlugins(),
    {
      approvalBroker: broker,
      approvalMode: mode,
      transcript,
      session,
      rules: new PermissionRules(config),
      context: {
        session_id: session.id,
        agent_id: 'agent',
        user_id: 'user',
      },
    }
  );
}

function toolCall(name, args, id = `${name}-call`) {
  return { id, type: 'function', function: { name, arguments: JSON.stringify(args) } };
}

test('ask tool creates pending approval and does not execute', async () => {
  const { workspace } = tmpWorkspace();
  const marker = path.join(workspace, 'ask-marker.txt');
  const config = { agent: { workspace }, tools: { enabled: ['touch'], policies: { touch: 'ask' } } };
  const registry = new ToolRegistry();
  registry.register(makeTool('touch', 'touch marker', { type: 'object', properties: {} }, async () => {
    fs.writeFileSync(marker, 'executed', 'utf-8');
    return 'executed';
  }).definition, async () => {
    fs.writeFileSync(marker, 'executed', 'utf-8');
    return 'executed';
  });
  const broker = makeBroker();
  const executor = makeExecutor({ config, registry, broker });

  const [result] = await executor.executeAll([toolCall('touch', {})]);

  assert.equal(result.denied, true);
  assert.equal(result.status, APPROVAL_STATUS.PENDING);
  assert.equal(broker.listPending({ toolName: 'touch' }).length, 1);
  assert.equal(fs.existsSync(marker), false);
  assert.match(result.result, /approval_required/);
});

test('destructive exec creates approval and does not execute without decision', async () => {
  const { workspace } = tmpWorkspace();
  const marker = path.join(workspace, 'exec-marker.txt');
  const command = `"${process.execPath}" -e "require('node:fs').writeFileSync('exec-marker.txt','run')"`;
  const config = {
    agent: { workspace },
    tools: { enabled: ['exec'], policies: { exec: 'allow' }, exec: { allowedCommands: [`"${process.execPath}"`], deniedCommands: [] } },
  };
  const registry = new ToolRegistry();
  const exec = createExecTool(config);
  registry.register(exec.definition, exec.handler);
  const broker = makeBroker();
  const executor = makeExecutor({ config, registry, broker });

  const [result] = await executor.executeAll([toolCall('exec', { command }, 'exec-pending')]);

  assert.equal(result.status, APPROVAL_STATUS.PENDING);
  assert.equal(broker.listPending({ toolName: 'exec' }).length, 1);
  assert.equal(fs.existsSync(marker), false);
});

test('approved request allows execution only when approval decision exists', async () => {
  const { workspace } = tmpWorkspace();
  const marker = path.join(workspace, 'approved-marker.txt');
  const command = `"${process.execPath}" -e "require('node:fs').writeFileSync('approved-marker.txt','ok')"`;
  const config = {
    agent: { workspace },
    tools: { enabled: ['exec'], policies: { exec: 'allow' }, exec: { allowedCommands: [`"${process.execPath}"`], deniedCommands: [] } },
  };
  const registry = new ToolRegistry();
  const exec = createExecTool(config);
  registry.register(exec.definition, exec.handler);
  const broker = makeBroker();
  const executor = makeExecutor({ config, registry, broker });

  const [pending] = await executor.executeAll([toolCall('exec', { command }, 'exec-approve-1')]);
  assert.equal(fs.existsSync(marker), false);

  broker.approve(pending.approvalId, {
    permissions: [APPROVAL_PERMISSIONS.TOOL_CALL],
    decidedBy: 'approver',
  }, 'approved for test');
  const [approved] = await executor.executeAll([toolCall('exec', { command, approvalId: pending.approvalId }, 'exec-approve-2')]);

  assert.equal(approved.denied, false);
  assert.equal(fs.readFileSync(marker, 'utf-8'), 'ok');
});

test('denied approval request never executes', async () => {
  const { workspace } = tmpWorkspace();
  const marker = path.join(workspace, 'denied-marker.txt');
  const command = `"${process.execPath}" -e "require('node:fs').writeFileSync('denied-marker.txt','bad')"`;
  const config = {
    agent: { workspace },
    tools: { enabled: ['exec'], policies: { exec: 'allow' }, exec: { allowedCommands: [`"${process.execPath}"`], deniedCommands: [] } },
  };
  const registry = new ToolRegistry();
  const exec = createExecTool(config);
  registry.register(exec.definition, exec.handler);
  const broker = makeBroker();
  const executor = makeExecutor({ config, registry, broker });

  const [pending] = await executor.executeAll([toolCall('exec', { command }, 'exec-deny-1')]);
  broker.deny(pending.approvalId, {
    permissions: [APPROVAL_PERMISSIONS.TOOL_CALL],
    decidedBy: 'approver',
  }, 'denied for test');
  const [denied] = await executor.executeAll([toolCall('exec', { command, approvalId: pending.approvalId }, 'exec-deny-2')]);

  assert.equal(denied.denied, true);
  assert.equal(denied.status, APPROVAL_STATUS.DENIED);
  assert.equal(fs.existsSync(marker), false);
});

test('approver without permission cannot approve', () => {
  const broker = makeBroker();
  const request = broker.submit({ type: APPROVAL_TYPES.TOOL_CALL, toolName: 'exec', reason: 'needs approval' });

  assert.throws(() => broker.approve(request.id, { permissions: [] }, 'nope'), ApprovalPermissionError);
  assert.equal(broker.get(request.id).status, APPROVAL_STATUS.PENDING);
});

test('approval request and decision are recorded to L2 system_event', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'myclaw-approval-audit-'));
  const router = new MemoryRouter({ memory: { root } });
  const transcript = new SessionTranscriptRecorder(router);
  const broker = makeBroker({ transcript });
  const context = { session_id: 'audit-session', agent_id: 'agent', user_id: 'user' };

  const request = broker.submit({
    type: APPROVAL_TYPES.TOOL_CALL,
    toolName: 'exec',
    reason: 'audit me',
  }, context);
  broker.approve(request.id, {
    ...context,
    permissions: [APPROVAL_PERMISSIONS.TOOL_CALL],
    decidedBy: 'auditor',
  }, 'ok');

  const records = router.session.list({ session_id: 'audit-session' }, 20);
  const contents = records.map(record => record.content).join('\n');
  assert.match(contents, /approval.submitted/);
  assert.match(contents, /approval.approved/);
  assert.equal(records.filter(record => record.key === 'system_event').length, 2);
});

test('default approval mode is safe manual, not auto-approve', async () => {
  const { workspace } = tmpWorkspace();
  const marker = path.join(workspace, 'manual-marker.txt');
  const config = { agent: { workspace }, tools: { enabled: ['touch'], policies: { touch: 'ask' } } };
  const registry = new ToolRegistry();
  registry.register(makeTool('touch', 'touch marker', { type: 'object', properties: {} }, async () => {
    fs.writeFileSync(marker, 'executed', 'utf-8');
    return 'executed';
  }).definition, async () => {
    fs.writeFileSync(marker, 'executed', 'utf-8');
    return 'executed';
  });
  const executor = makeExecutor({ config, registry, broker: makeBroker() });

  const [result] = await executor.executeAll([toolCall('touch', {})]);

  assert.equal(result.status, APPROVAL_STATUS.PENDING);
  assert.equal(fs.existsSync(marker), false);
});

test('deny approval mode records a denied decision without executing', async () => {
  const { workspace } = tmpWorkspace();
  const marker = path.join(workspace, 'deny-mode-marker.txt');
  const config = { agent: { workspace }, tools: { enabled: ['touch'], policies: { touch: 'ask' } } };
  const registry = new ToolRegistry();
  registry.register(makeTool('touch', 'touch marker', { type: 'object', properties: {} }, async () => {
    fs.writeFileSync(marker, 'executed', 'utf-8');
    return 'executed';
  }).definition, async () => {
    fs.writeFileSync(marker, 'executed', 'utf-8');
    return 'executed';
  });
  const broker = makeBroker();
  const executor = makeExecutor({ config, registry, broker, mode: 'deny' });

  const [result] = await executor.executeAll([toolCall('touch', {})]);

  assert.equal(result.status, APPROVAL_STATUS.DENIED);
  assert.equal([...broker.requests.values()][0].status, APPROVAL_STATUS.DENIED);
  assert.equal(fs.existsSync(marker), false);
});

test('auto_for_tests mode is explicit and executes after internal approval', async () => {
  const { workspace } = tmpWorkspace();
  const marker = path.join(workspace, 'auto-marker.txt');
  const config = { agent: { workspace }, tools: { enabled: ['touch'], policies: { touch: 'ask' } } };
  const registry = new ToolRegistry();
  registry.register(makeTool('touch', 'touch marker', { type: 'object', properties: {} }, async () => {
    fs.writeFileSync(marker, 'executed', 'utf-8');
    return 'executed';
  }).definition, async () => {
    fs.writeFileSync(marker, 'executed', 'utf-8');
    return 'executed';
  });
  const broker = makeBroker();
  const executor = makeExecutor({ config, registry, broker, mode: 'auto_for_tests' });

  const [result] = await executor.executeAll([toolCall('touch', {})]);

  assert.equal(result.denied, false);
  assert.equal(fs.readFileSync(marker, 'utf-8'), 'executed');
  assert.equal([...broker.requests.values()][0].status, APPROVAL_STATUS.APPROVED);
});

test('ToolPolicy deny still denies without approval request', async () => {
  const { workspace } = tmpWorkspace();
  const config = { agent: { workspace }, tools: { enabled: ['touch'], policies: { touch: 'deny' } } };
  const registry = new ToolRegistry();
  registry.register(makeTool('touch', 'touch marker', { type: 'object', properties: {} }, async () => 'executed').definition, async () => 'executed');
  const broker = makeBroker();
  const executor = makeExecutor({ config, registry, broker });

  const [result] = await executor.executeAll([toolCall('touch', {})]);

  assert.equal(result.denied, true);
  assert.match(result.result, /denied by policy/);
  assert.equal(broker.listPending().length, 0);
});
