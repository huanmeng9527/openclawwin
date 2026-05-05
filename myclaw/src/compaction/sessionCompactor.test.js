import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { AuditLog } from '../audit/index.js';
import { MemoryRouter } from '../memory/index.js';
import { PromptAssembler } from '../prompt/assembler.js';
import { QueryEngine } from '../engine/query.js';
import { SessionTranscriptRecorder } from '../session/transcript.js';
import { ToolRegistry } from '../tools/registry.js';
import { SUMMARY_TYPE, SessionCompactor } from './index.js';

class EmptySkills {
  buildPrompt() { return ''; }
}

class EmptyPlugins {
  async runHook(_name, context) { return context; }
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

function tmpRoot(prefix = 'myclaw-session-compact-') {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

function makeConfig(root, compaction = {}) {
  return {
    agent: { name: 'myclaw', workspace: root, streaming: false, maxIterations: 4 },
    provider: { type: 'openai', model: 'fake', maxTokens: 2048 },
    tools: { enabled: [], policies: {} },
    memory: {
      root: path.join(root, 'memory'),
      promptBudgetChars: 4000,
      compaction: {
        enabled: true,
        maxEventsBeforeCompact: 30,
        maxCharsBeforeCompact: 20000,
        maxSummaryChars: 1200,
        keepRecentEvents: 2,
        ...compaction,
      },
    },
  };
}

function appendSessionEvents(router, sessionId, count, prefix = 'alpha') {
  for (let index = 0; index < count; index++) {
    const eventType = index % 2 === 0 ? 'user_message' : 'assistant_message';
    router.appendSessionEvent({
      event_id: `${sessionId}:evt-${index}`,
      event_type: eventType,
      session_id: sessionId,
      title: eventType,
      content: `${prefix} ${eventType} ${index}`,
    }, { session_id: sessionId });
  }
}

function summaryRecords(router, sessionId) {
  return router.session
    .list({ session_id: sessionId }, 100)
    .filter(record => record.metadata?.summaryType === SUMMARY_TYPE);
}

test('SessionCompactor.shouldCompact returns true when event count exceeds threshold', () => {
  const compactor = new SessionCompactor(null);
  const events = Array.from({ length: 3 }, (_, index) => ({
    id: `evt-${index}`,
    layer: 'session',
    key: 'user_message',
    content: `message ${index}`,
    created_at: `2026-01-01T00:00:0${index}.000Z`,
    metadata: {},
  }));

  assert.equal(compactor.shouldCompact(events, { maxEventsBeforeCompact: 2, keepRecentEvents: 0 }), true);
});

test('compactSession generates L2 summary, system_event, and audit event', () => {
  const root = tmpRoot();
  const auditLog = new AuditLog({}, { filePath: path.join(root, 'audit.log') });
  const router = new MemoryRouter(makeConfig(root), { auditLog });
  const transcript = new SessionTranscriptRecorder(router);
  const compactor = new SessionCompactor(router, { auditLog, transcript, config: makeConfig(root) });
  appendSessionEvents(router, 's1', 5, 'compact target');

  const summary = compactor.compactSession('s1', { session_id: 's1', agent_id: 'agent', user_id: 'user' }, {
    maxEventsBeforeCompact: 2,
    keepRecentEvents: 1,
  });

  assert.equal(summary.layer, 'session');
  assert.equal(summary.metadata.summaryType, SUMMARY_TYPE);
  assert.match(summary.content, /Generated deterministic L2 session summary/);
  assert.equal(summaryRecords(router, 's1').length, 1);
  assert.equal(router.semantic.search('Generated deterministic L2 session summary', {}, 10).length, 0);
  assert.ok(router.session.list({ session_id: 's1' }, 20).some(record => record.content.includes('session.compacted')));
  assert.equal(auditLog.query({ eventType: 'session.compaction.run', sessionId: 's1' }).length, 1);
});

test('PromptAssembler prioritizes L2 summary and keeps recent events', async () => {
  const root = tmpRoot();
  const config = makeConfig(root, { keepRecentEvents: 1 });
  const router = new MemoryRouter(config);
  appendSessionEvents(router, 's1', 4, 'old prompt detail');
  const compactor = new SessionCompactor(router, { config });
  compactor.compactSession('s1', { session_id: 's1' }, { maxEventsBeforeCompact: 2, keepRecentEvents: 1 });

  router.appendSessionEvent({
    event_id: 's1:recent',
    event_type: 'user_message',
    session_id: 's1',
    content: 'fresh recent event banana',
  }, { session_id: 's1' });

  const assembler = new PromptAssembler({
    config,
    toolRegistry: new ToolRegistry(),
    skillLoader: new EmptySkills(),
    pluginManager: new EmptyPlugins(),
    memoryRouter: router,
  });
  const prompt = await assembler.assemble({ session: { id: 's1', messages: [] }, userInput: 'banana' });

  assert.match(prompt, /Session summary/);
  assert.match(prompt, /fresh recent event banana/);
  assert.ok(prompt.indexOf('Session summary') < prompt.indexOf('fresh recent event banana'));
});

test('compaction does not generate duplicate summary records without new compactable events', () => {
  const root = tmpRoot();
  const config = makeConfig(root, { keepRecentEvents: 1 });
  const router = new MemoryRouter(config);
  const compactor = new SessionCompactor(router, { config });
  appendSessionEvents(router, 's1', 5, 'dedupe target');

  const first = compactor.compactSession('s1', { session_id: 's1' }, { maxEventsBeforeCompact: 2, keepRecentEvents: 1 });
  const second = compactor.compactSession('s1', { session_id: 's1' }, { maxEventsBeforeCompact: 2, keepRecentEvents: 1 });

  assert.ok(first);
  assert.equal(second, null);
  assert.equal(summaryRecords(router, 's1').length, 1);
});

test('QueryEngine auto-triggers L2 compaction with low threshold', async () => {
  const root = tmpRoot('myclaw-engine-compact-');
  process.env.MYCLAW_HOME = path.join(root, 'home');
  const config = makeConfig(root, {
    maxEventsBeforeCompact: 1,
    keepRecentEvents: 0,
  });
  const auditLog = new AuditLog(config, { filePath: path.join(root, 'audit.log') });
  const provider = new FakeProvider([{ role: 'assistant', content: 'compact answer' }]);
  const engine = new QueryEngine(config, { provider, auditLog });
  await engine.init();

  const result = await engine.run('please compact this session', null, { stream: false });

  assert.equal(result.sessionCompacted, true);
  assert.equal(summaryRecords(engine.memoryRouter, result.session.id).length, 1);
  assert.ok(result.events.some(event => event.type === 'session_compaction'));
  assert.equal(auditLog.query({ eventType: 'session.compaction.run', sessionId: result.session.id }).length, 1);
});
