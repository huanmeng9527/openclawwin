import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { MemoryRecord, MemoryRouter, MEMORY_PERMISSIONS } from './index.js';

function tmpRoot() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'myclaw-memory-'));
}

test('L1 working memory is in-process and isolated by session/agent/lane', () => {
  const root = tmpRoot();
  const router = new MemoryRouter({ memory: { root } });

  router.write(new MemoryRecord({
    layer: 'working',
    content: 'alpha working main',
    session_id: 's1',
    agent_id: 'a1',
    lane_id: 'main',
  }), 'working', {});
  router.write(new MemoryRecord({
    layer: 'working',
    content: 'alpha working side',
    session_id: 's1',
    agent_id: 'a1',
    lane_id: 'side',
  }), 'working', {});

  const main = router.retrieve('alpha', { session_id: 's1', agent_id: 'a1', lane_id: 'main' }, { layers: ['working'] });
  const fresh = new MemoryRouter({ memory: { root } }).retrieve('alpha', {}, { layers: ['working'] });

  assert.equal(main.length, 1);
  assert.match(main[0].record.content, /main/);
  assert.equal(fresh.length, 0);
});

test('L2 append/search works', () => {
  const root = tmpRoot();
  const router = new MemoryRouter({ memory: { root } });

  router.appendSessionEvent({
    event_id: 'evt-1',
    event_type: 'user_message',
    session_id: 's1',
    content: 'user asked about alpha',
  });
  router.appendSessionEvent({
    event_id: 'evt-2',
    event_type: 'assistant_message',
    session_id: 's2',
    content: 'other alpha',
  });

  const results = router.retrieve('alpha', { session_id: 's1' }, { layers: ['session'] });
  assert.equal(results.length, 1);
  assert.equal(results[0].record.id, 'evt-1');
});

test('L3 writes Markdown then reindexes/searches', () => {
  const root = tmpRoot();
  const router = new MemoryRouter({ memory: { root } });

  router.write(new MemoryRecord({
    id: 'semantic-alpha',
    layer: 'semantic',
    title: 'Alpha fact',
    content: 'alpha semantic host fact',
    tags: ['facts'],
    metadata: { category: 'facts' },
  }), 'semantic', { permissions: [MEMORY_PERMISSIONS.WRITE] });

  const markdown = path.join(root, 'semantic', 'facts.md');
  const first = router.reindex('semantic', { permissions: [MEMORY_PERMISSIONS.REINDEX] });
  const second = router.reindex('semantic', { permissions: [MEMORY_PERMISSIONS.REINDEX] });
  const results = router.retrieve('semantic host', { permissions: [MEMORY_PERMISSIONS.READ] }, { layers: ['semantic'] });

  assert.equal(first.semantic, 1);
  assert.equal(second.semantic, 1);
  assert.match(fs.readFileSync(markdown, 'utf-8'), /semantic-alpha/);
  assert.equal(results[0].record.id, 'semantic-alpha');
});

test('L4 procedural write requires stronger permission and filters', () => {
  const root = tmpRoot();
  const router = new MemoryRouter({ memory: { root } });
  const record = new MemoryRecord({
    id: 'proc-alpha',
    layer: 'procedural',
    content: 'Use read-only diagnostics before shell mutation',
    metadata: { category: 'runbooks', tool_name: 'exec', capability: 'diagnostics' },
    risk_level: 'medium',
  });

  assert.throws(() => router.write(record, 'procedural', { permissions: [MEMORY_PERMISSIONS.WRITE] }), /procedural/);
  router.write(record, 'procedural', { permissions: [MEMORY_PERMISSIONS.PROCEDURAL_WRITE] });

  const results = router.retrieve('diagnostics', {
    permissions: [MEMORY_PERMISSIONS.READ],
    tool_name: 'exec',
    capability: 'diagnostics',
    risk_level: 'medium',
  }, { layers: ['procedural'] });
  assert.equal(results.length, 1);
});

test('MemoryRouter retrieves across layers with score/source/reason and budget trimming', () => {
  const root = tmpRoot();
  const router = new MemoryRouter({ memory: { root } });
  router.write(new MemoryRecord({ layer: 'working', content: 'alpha alpha compact', title: 'working' }), 'working', {});
  router.appendSessionEvent({ event_id: 'evt-alpha', event_type: 'user_message', session_id: 's1', content: 'alpha session event' });
  router.write(new MemoryRecord({ id: 'sem-alpha', layer: 'semantic', content: 'alpha semantic fact' }), 'semantic', { permissions: [MEMORY_PERMISSIONS.WRITE] });
  router.write(new MemoryRecord({ id: 'proc-alpha', layer: 'procedural', content: 'alpha procedural playbook' }), 'procedural', { permissions: [MEMORY_PERMISSIONS.PROCEDURAL_WRITE] });

  const results = router.retrieve('alpha', { permissions: [MEMORY_PERMISSIONS.READ] }, { limit: 10 });
  const budgeted = router.retrieve('alpha', { permissions: [MEMORY_PERMISSIONS.READ] }, { limit: 10, budgetChars: 120 });

  assert.deepEqual(results.map(r => r.layer), ['working', 'session', 'semantic', 'procedural']);
  assert.ok(results.every(r => typeof r.score === 'number' && r.source && r.reason));
  assert.ok(budgeted.length < results.length);
});

test('delete removes records from search', () => {
  const root = tmpRoot();
  const router = new MemoryRouter({ memory: { root } });
  router.write(new MemoryRecord({ id: 'delete-alpha', layer: 'semantic', content: 'delete alpha memory' }), 'semantic', {
    permissions: [MEMORY_PERMISSIONS.WRITE],
  });

  assert.equal(router.retrieve('delete alpha', { permissions: [MEMORY_PERMISSIONS.READ] }, { layers: ['semantic'] }).length, 1);
  assert.equal(router.delete('delete-alpha', { permissions: [MEMORY_PERMISSIONS.DELETE] }), true);
  assert.equal(router.retrieve('delete alpha', { permissions: [MEMORY_PERMISSIONS.READ] }, { layers: ['semantic'] }).length, 0);
});

test('L3/L4 prompt injection skipped without memory.read', () => {
  const root = tmpRoot();
  const router = new MemoryRouter({ memory: { root } });
  router.write(new MemoryRecord({ id: 'hidden-alpha', layer: 'semantic', content: 'hidden alpha fact' }), 'semantic', {
    permissions: [MEMORY_PERMISSIONS.WRITE],
  });

  assert.equal(router.retrieve('hidden alpha', {}, { layers: ['semantic'] }).length, 0);
});
