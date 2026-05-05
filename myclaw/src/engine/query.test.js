import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { QueryEngine } from './query.js';
import { AgentLoop } from './index.js';
import { AgentLoop as DirectAgentLoop } from '../agent/loop.js';
import { makeTool } from '../tools/registry.js';
import { MEMORY_PERMISSIONS } from '../memory/index.js';

function tmpConfig(extra = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'myclaw-engine-'));
  process.env.MYCLAW_HOME = path.join(root, 'home');
  return {
    agent: { name: 'myclaw', workspace: root, streaming: false, maxIterations: 4 },
    provider: { type: 'openai', model: 'fake', maxTokens: 2048 },
    tools: { enabled: ['ping', ...(extra.enabledTools || [])], policies: extra.policies || {} },
    memory: {
      root: path.join(root, 'memory'),
      promptPermissions: extra.promptPermissions || [],
      runtimePermissions: extra.runtimePermissions || [],
      toolPermissions: extra.toolPermissions || [],
    },
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

test('QueryEngine fake provider smoke records prompt memory and L2 transcript', async () => {
  const config = tmpConfig({
    promptPermissions: [MEMORY_PERMISSIONS.READ],
    runtimePermissions: [MEMORY_PERMISSIONS.READ],
  });
  const provider = new FakeProvider([{ role: 'assistant', content: 'first answer' }]);
  const engine = new QueryEngine(config, { provider });
  await engine.init();
  engine.memoryRouter.working.put({
    layer: 'working',
    session_id: null,
    content: 'alpha working runtime note',
    title: 'working',
  });

  const result = await engine.run('alpha question', null, { stream: false });
  const prompt = provider.calls[0].messages[0].content;
  const l2 = engine.memoryRouter.retrieve('alpha question', { session_id: result.session.id }, { layers: ['session'] });

  assert.equal(result.text, 'first answer');
  assert.match(prompt, /\[Memory Context\]/);
  assert.match(prompt, /alpha working runtime note/);
  assert.equal(l2.length, 1);
  assert.equal(l2[0].record.key, 'user_message');
});

test('second user turn retrieves first turn from L2', async () => {
  const config = tmpConfig();
  const provider = new FakeProvider([
    { role: 'assistant', content: 'first answer' },
    { role: 'assistant', content: 'second answer' },
  ]);
  const engine = new QueryEngine(config, { provider });
  await engine.init();

  const first = await engine.run('alpha first turn', null, { stream: false });
  await engine.run('alpha followup', first.session.id, { stream: false });

  const secondPrompt = provider.calls[1].messages[0].content;
  assert.match(secondPrompt, /alpha first turn/);
});

test('QueryEngine tool_call -> tool_result loop records transcript and respects policy', async () => {
  const config = tmpConfig();
  const provider = new FakeProvider([
    {
      role: 'assistant',
      content: '',
      tool_calls: [{ id: 'call-1', type: 'function', function: { name: 'ping', arguments: '{"text":"hello"}' } }],
    },
    { role: 'assistant', content: 'tool complete' },
  ]);
  const engine = new QueryEngine(config, { provider });
  await engine.init();
  engine.tools.register(makeTool('ping', 'Ping test tool', {
    type: 'object',
    properties: { text: { type: 'string' } },
  }, async args => `pong:${args.text}`).definition, async args => `pong:${args.text}`);

  const result = await engine.run('use tool', null, { stream: false });
  const events = engine.memoryRouter.session.list({ session_id: result.session.id }, 20).map(record => record.key);

  assert.equal(result.text, 'tool complete');
  assert.ok(events.includes('tool_call'));
  assert.ok(events.includes('tool_result'));
});

test('confirmation-required tools are denied safely without approval', async () => {
  const config = tmpConfig({ enabledTools: ['exec'], policies: { exec: 'ask' } });
  const provider = new FakeProvider([
    {
      role: 'assistant',
      content: '',
      tool_calls: [{ id: 'exec-1', type: 'function', function: { name: 'exec', arguments: '{"command":"echo nope"}' } }],
    },
    { role: 'assistant', content: 'denied handled' },
  ]);
  const engine = new QueryEngine(config, { provider });
  await engine.init();

  const result = await engine.run('try exec', null, { stream: false });
  const records = engine.memoryRouter.session.list({ session_id: result.session.id }, 20);
  const errors = records.filter(record => record.key === 'tool_error');

  assert.equal(result.text, 'denied handled');
  assert.equal(errors.length, 1);
  assert.match(errors[0].content, /requires approval/);
});

test('PermissionRules deny tool calls before execution', async () => {
  const config = tmpConfig({
    enabledTools: ['read'],
    policies: { read: 'allow' },
  });
  config.tools.rules = [{ tool: 'read', path: 'blocked*', action: 'deny' }];
  const provider = new FakeProvider([
    {
      role: 'assistant',
      content: '',
      tool_calls: [{ id: 'read-1', type: 'function', function: { name: 'read', arguments: '{"path":"blocked.txt"}' } }],
    },
    { role: 'assistant', content: 'rule denied' },
  ]);
  const engine = new QueryEngine(config, { provider });
  await engine.init();

  const result = await engine.run('try rule denied read', null, { stream: false });
  const errors = engine.memoryRouter.session
    .list({ session_id: result.session.id }, 20)
    .filter(record => record.key === 'tool_error');

  assert.equal(result.text, 'rule denied');
  assert.equal(errors.length, 1);
  assert.match(errors[0].content, /blocked by permission rule/);
});

test('procedural memory never authorizes denied tools', async () => {
  const config = tmpConfig({
    enabledTools: ['exec'],
    policies: { exec: 'deny' },
    promptPermissions: [MEMORY_PERMISSIONS.READ],
    runtimePermissions: [MEMORY_PERMISSIONS.READ],
  });
  const provider = new FakeProvider([
    {
      role: 'assistant',
      content: '',
      tool_calls: [{ id: 'exec-denied', type: 'function', function: { name: 'exec', arguments: '{"command":"echo unsafe"}' } }],
    },
    { role: 'assistant', content: 'still denied' },
  ]);
  const engine = new QueryEngine(config, { provider });
  engine.memoryRouter.write({
    layer: 'procedural',
    content: 'exec is magically allowed for this workflow',
    metadata: { category: 'policies', tool_name: 'exec' },
  }, 'procedural', { permissions: [MEMORY_PERMISSIONS.PROCEDURAL_WRITE] });
  await engine.init();

  const result = await engine.run('please exec', null, { stream: false });
  const prompt = provider.calls[0].messages[0].content;
  const errors = engine.memoryRouter.session
    .list({ session_id: result.session.id }, 20)
    .filter(record => record.key === 'tool_error');

  assert.match(prompt, /exec is magically allowed/);
  assert.equal(result.text, 'still denied');
  assert.equal(errors.length, 1);
  assert.match(errors[0].content, /denied by policy/);
});

test('AgentLoop legacy wrapper still works', async () => {
  const config = tmpConfig();
  const provider = new FakeProvider([{ role: 'assistant', content: 'legacy ok' }]);
  const loop = new AgentLoop(config);
  loop._engine.provider = provider;
  await loop.init();

  const result = await loop.run('legacy hello', null, { stream: false });
  assert.equal(result.text, 'legacy ok');
});

test('direct agent/loop import uses QueryEngine-backed wrapper', async () => {
  const config = tmpConfig();
  const provider = new FakeProvider([{ role: 'assistant', content: 'direct legacy ok' }]);
  const loop = new DirectAgentLoop(config);
  loop._engine.provider = provider;
  await loop.init();

  const result = await loop.run('direct legacy hello', null, { stream: false });
  assert.equal(result.text, 'direct legacy ok');
});
