import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { AuditLog } from '../audit/index.js';
import { APPROVAL_PERMISSIONS } from '../approval/index.js';
import { SessionCompactor } from '../compaction/index.js';
import {
  memoryProposalsApproveCommand,
  memoryProposalsListCommand,
  memoryProposalsShowCommand,
  memoryProposalsWriteCommand,
} from '../cli/commands/memory.js';
import { PromptAssembler } from '../prompt/assembler.js';
import { ToolRegistry } from '../tools/registry.js';
import {
  MEMORY_PERMISSIONS,
  MEMORY_PROPOSAL_STATUS,
  MemoryProposalStore,
  MemoryRecord,
  MemoryRouter,
  StableFactExtractor,
} from './index.js';

class EmptySkills {
  buildPrompt() { return ''; }
}

class EmptyPlugins {
  async runHook(_name, context) { return context; }
}

function tmpConfig(extra = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'myclaw-proposals-'));
  return {
    agent: { name: 'myclaw', workspace: root },
    tools: { enabled: [], policies: {} },
    memory: {
      root: path.join(root, 'memory'),
      promptBudgetChars: 4000,
      promptPermissions: extra.promptPermissions || [],
      proposals: {
        enabled: true,
        autoCreateFromCompaction: false,
        minConfidence: 0.7,
        maxCandidatesPerSummary: 5,
        ...(extra.proposals || {}),
      },
      compaction: {
        enabled: true,
        maxEventsBeforeCompact: 2,
        maxCharsBeforeCompact: 20000,
        maxSummaryChars: 2000,
        keepRecentEvents: 0,
        ...(extra.compaction || {}),
      },
    },
  };
}

function makeStore(config, auditLog = null) {
  const router = new MemoryRouter(config, { auditLog });
  const store = new MemoryProposalStore({
    config,
    memoryRouter: router,
    auditLog,
    filePath: path.join(config.memory.root, 'proposals', 'proposals.json'),
  });
  return { router, store };
}

function withTempHome(fn) {
  const previous = process.env.MYCLAW_HOME;
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'myclaw-proposal-cli-'));
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

function stableSummary() {
  return new MemoryRecord({
    id: 'session_summary:s1',
    layer: 'session',
    session_id: 's1',
    title: 'Session summary',
    key: 'session_summary:s1',
    content: [
      '[Generated deterministic L2 session summary]',
      'Remember: the user preference is concise Chinese responses.',
      'Project decision: MyClaw stores semantic memory in Markdown.',
      'Temporary task status: run tests today.',
    ].join('\n'),
    metadata: {
      summaryType: 'l2_session_summary',
      sourceEventIds: ['evt-1', 'evt-2'],
    },
  });
}

test('StableFactExtractor extracts deterministic candidates from L2 summary', () => {
  const extractor = new StableFactExtractor();
  const candidates = extractor.extractCandidatesFromSummary(stableSummary(), { session_id: 's1' });

  assert.ok(candidates.length >= 2);
  assert.ok(candidates.some(candidate => candidate.type === 'preference'));
  assert.ok(candidates.some(candidate => candidate.type === 'decision'));
  assert.equal(candidates[0].sourceSessionId, 's1');
  assert.equal(candidates[0].sourceSummaryId, 'session_summary:s1');
});

test('StableFactExtractor skips tool noise and temporary errors', () => {
  const extractor = new StableFactExtractor();
  const candidates = extractor.extractCandidatesFromSummary(new MemoryRecord({
    id: 'session_summary:noise',
    layer: 'session',
    session_id: 'noise',
    content: [
      'tool_call exec: remember command failed',
      'tool_error Error: password auth failed',
      'approval.submitted for exec',
      'Temporary task status: remember to retry today',
    ].join('\n'),
    metadata: { summaryType: 'l2_session_summary' },
  }), { session_id: 'noise' });

  assert.equal(candidates.length, 0);
});

test('createProposal does not write L3 semantic memory', () => {
  const config = tmpConfig();
  const { router, store } = makeStore(config);
  const candidate = new StableFactExtractor().extractCandidatesFromSummary(stableSummary(), { session_id: 's1' })[0];
  const proposal = store.createProposal(candidate, { session_id: 's1' });

  assert.equal(proposal.status, MEMORY_PROPOSAL_STATUS.PENDING);
  assert.equal(router.semantic.search(candidate.content, {}, 10).length, 0);
});

test('pending proposal does not enter L3 prompt memory', async () => {
  const config = tmpConfig({ promptPermissions: [MEMORY_PERMISSIONS.READ] });
  const { router, store } = makeStore(config);
  const candidate = new StableFactExtractor().extractCandidatesFromSummary(stableSummary(), { session_id: 's1' })[0];
  store.createProposal(candidate, { session_id: 's1' });
  const assembler = new PromptAssembler({
    config,
    toolRegistry: new ToolRegistry(),
    skillLoader: new EmptySkills(),
    pluginManager: new EmptyPlugins(),
    memoryRouter: router,
  });

  const prompt = await assembler.assemble({ session: { id: 's1', messages: [] }, userInput: 'unrelated query' });

  assert.doesNotMatch(prompt, /concise Chinese responses/);
});

test('approveProposal requires memory or approval permission', () => {
  const config = tmpConfig();
  const { store } = makeStore(config);
  const candidate = new StableFactExtractor().extractCandidatesFromSummary(stableSummary(), { session_id: 's1' })[0];
  const proposal = store.createProposal(candidate, { session_id: 's1' });

  assert.throws(() => store.approveProposal(proposal.id, { permissions: [] }, 'no permission'), /requires one of/);
  const approved = store.approveProposal(proposal.id, {
    permissions: [APPROVAL_PERMISSIONS.MEMORY_WRITE],
    decidedBy: 'reviewer',
  }, 'approved');
  assert.equal(approved.status, MEMORY_PROPOSAL_STATUS.APPROVED);
});

test('rejectProposal prevents L3 write', () => {
  const config = tmpConfig();
  const { store } = makeStore(config);
  const candidate = new StableFactExtractor().extractCandidatesFromSummary(stableSummary(), { session_id: 's1' })[0];
  const proposal = store.createProposal(candidate, { session_id: 's1' });

  store.rejectProposal(proposal.id, { permissions: [MEMORY_PERMISSIONS.WRITE], decidedBy: 'reviewer' }, 'not stable');

  assert.throws(() => store.writeApprovedProposal(proposal.id, { permissions: [MEMORY_PERMISSIONS.WRITE] }), /rejected proposal/);
});

test('writeApprovedProposal writes L3 through MemoryRouter and is idempotent', () => {
  const config = tmpConfig();
  const { router, store } = makeStore(config);
  const candidate = new StableFactExtractor().extractCandidatesFromSummary(stableSummary(), { session_id: 's1' })[0];
  const proposal = store.createProposal(candidate, { session_id: 's1' });

  store.approveProposal(proposal.id, { permissions: [MEMORY_PERMISSIONS.WRITE], decidedBy: 'reviewer' }, 'stable');
  const written = store.writeApprovedProposal(proposal.id, { permissions: [APPROVAL_PERMISSIONS.MEMORY_WRITE], session_id: 's1' });
  const again = store.writeApprovedProposal(proposal.id, { permissions: [APPROVAL_PERMISSIONS.MEMORY_WRITE], session_id: 's1' });
  const semanticRecords = router.semantic.list({}, 100).filter(record => record.metadata?.proposalId === proposal.id);

  assert.equal(written.status, MEMORY_PROPOSAL_STATUS.WRITTEN);
  assert.equal(again.targetMemoryId, written.targetMemoryId);
  assert.equal(semanticRecords.length, 1);
});

test('proposal lifecycle writes AuditLog events', () => {
  const config = tmpConfig();
  const auditLog = new AuditLog(config, { filePath: path.join(config.memory.root, 'audit.log') });
  const { store } = makeStore(config, auditLog);
  const candidates = new StableFactExtractor().extractCandidatesFromSummary(stableSummary(), { session_id: 's1' });
  const first = store.createProposal(candidates[0], { session_id: 's1', agent_id: 'agent' });
  const second = store.createProposal(candidates[1], { session_id: 's1', agent_id: 'agent' });

  store.approveProposal(first.id, { permissions: [MEMORY_PERMISSIONS.WRITE], agent_id: 'agent' }, 'ok');
  store.writeApprovedProposal(first.id, { permissions: [MEMORY_PERMISSIONS.WRITE], agent_id: 'agent' });
  store.rejectProposal(second.id, { permissions: [MEMORY_PERMISSIONS.WRITE], agent_id: 'agent' }, 'reject');

  assert.equal(auditLog.query({ eventType: 'memory.proposal.created' }).length, 2);
  assert.equal(auditLog.query({ eventType: 'memory.proposal.approved' }).length, 1);
  assert.equal(auditLog.query({ eventType: 'memory.proposal.written' }).length, 1);
  assert.equal(auditLog.query({ eventType: 'memory.proposal.rejected' }).length, 1);
});

test('writeApprovedProposal denied path writes AuditLog event', () => {
  const config = tmpConfig();
  const auditLog = new AuditLog(config, { filePath: path.join(config.memory.root, 'audit.log') });
  const { store } = makeStore(config, auditLog);
  const candidate = new StableFactExtractor().extractCandidatesFromSummary(stableSummary(), { session_id: 's1' })[0];
  const proposal = store.createProposal(candidate, { session_id: 's1' });
  store.approveProposal(proposal.id, { permissions: [MEMORY_PERMISSIONS.WRITE] }, 'ok');

  assert.throws(() => store.writeApprovedProposal(proposal.id, { permissions: [] }), /semantic memory operation/);
  assert.equal(auditLog.query({ eventType: 'memory.proposal.write_denied' }).length, 1);
});

test('SessionCompactor creates pending proposals when enabled and never auto-writes L3', () => {
  const config = tmpConfig({
    proposals: { autoCreateFromCompaction: true, maxCandidatesPerSummary: 3 },
    compaction: { maxEventsBeforeCompact: 1, keepRecentEvents: 0 },
  });
  const auditLog = new AuditLog(config, { filePath: path.join(config.memory.root, 'audit.log') });
  const { router, store } = makeStore(config, auditLog);
  const compactor = new SessionCompactor(router, { config, auditLog, proposalStore: store });
  router.appendSessionEvent({
    event_id: 'evt-1',
    event_type: 'user_message',
    session_id: 's1',
    content: 'Remember: 用户偏好是使用中文总结。',
  }, { session_id: 's1' });
  router.appendSessionEvent({
    event_id: 'evt-2',
    event_type: 'assistant_message',
    session_id: 's1',
    content: 'Project decision: keep L3 writes manual.',
  }, { session_id: 's1' });

  compactor.compactSession('s1', { session_id: 's1', agent_id: 'agent' });

  assert.ok(store.listProposals({ status: MEMORY_PROPOSAL_STATUS.PENDING }).length >= 1);
  assert.equal(router.semantic.list({}, 10).length, 0);
});

test('default proposal config does not auto-write or auto-create from compaction', () => {
  const config = tmpConfig();
  const { router, store } = makeStore(config);
  const compactor = new SessionCompactor(router, { config, proposalStore: store });
  router.appendSessionEvent({
    event_id: 'evt-1',
    event_type: 'user_message',
    session_id: 's1',
    content: 'Remember: default config should not create proposal automatically.',
  }, { session_id: 's1' });
  router.appendSessionEvent({
    event_id: 'evt-2',
    event_type: 'assistant_message',
    session_id: 's1',
    content: 'Decision: no auto L3 write.',
  }, { session_id: 's1' });

  compactor.compactSession('s1', { session_id: 's1' });

  assert.equal(store.listProposals({}).length, 0);
  assert.equal(router.semantic.list({}, 10).length, 0);
});

test('memory proposal CLI handlers list, show, approve, and write with temporary MYCLAW_HOME', () => withTempHome(() => {
  const router = new MemoryRouter({});
  const store = new MemoryProposalStore({ memoryRouter: router });
  const candidate = new StableFactExtractor().extractCandidatesFromSummary(stableSummary(), { session_id: 's1' })[0];
  const proposal = store.createProposal(candidate, { session_id: 's1' });

  const listOutput = captureOutput(() => memoryProposalsListCommand({}));
  const showOutput = captureOutput(() => memoryProposalsShowCommand(proposal.id));
  const approveOutput = captureOutput(() => memoryProposalsApproveCommand(proposal.id, { reason: 'cli ok' }));
  const writeOutput = captureOutput(() => memoryProposalsWriteCommand(proposal.id));

  assert.match(listOutput, new RegExp(proposal.id));
  assert.match(showOutput, /Candidate preference/);
  assert.match(approveOutput, /approved/);
  assert.match(writeOutput, /written/);
}));
