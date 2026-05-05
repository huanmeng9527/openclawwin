import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { MemoryRecord, MemoryRouter, MEMORY_PERMISSIONS } from '../memory/index.js';
import { PromptAssembler } from './assembler.js';
import { ToolRegistry } from '../tools/registry.js';

class EmptySkills {
  buildPrompt() { return ''; }
}

class EmptyPlugins {
  async runHook(_name, context) { return context; }
}

function makeConfig(root, permissions = []) {
  return {
    agent: { name: 'myclaw', workspace: root },
    memory: { root: path.join(root, 'memory'), promptPermissions: permissions },
  };
}

test('PromptAssembler calls MemoryRouter.retrieveForPrompt and emits Memory Context', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'myclaw-prompt-'));
  const router = new MemoryRouter(makeConfig(root, [MEMORY_PERMISSIONS.READ]));
  let called = false;
  const original = router.retrieveForPrompt.bind(router);
  router.retrieveForPrompt = (...args) => {
    called = true;
    return original(...args);
  };
  router.write(new MemoryRecord({ layer: 'working', content: 'alpha working note', session_id: 's1' }), 'working', {});
  router.appendSessionEvent({ event_id: 'evt-1', event_type: 'user_message', session_id: 's1', content: 'alpha session note' });
  router.write(new MemoryRecord({ layer: 'semantic', content: 'alpha semantic note' }), 'semantic', { permissions: [MEMORY_PERMISSIONS.WRITE] });
  router.write(new MemoryRecord({ layer: 'procedural', content: 'alpha procedural note' }), 'procedural', { permissions: [MEMORY_PERMISSIONS.PROCEDURAL_WRITE] });

  const assembler = new PromptAssembler({
    config: makeConfig(root, [MEMORY_PERMISSIONS.READ]),
    toolRegistry: new ToolRegistry(),
    skillLoader: new EmptySkills(),
    pluginManager: new EmptyPlugins(),
    memoryRouter: router,
  });
  const prompt = await assembler.assemble({ session: { id: 's1', messages: [] }, userInput: 'alpha' });

  assert.equal(called, true);
  assert.match(prompt, /\[Memory Context\]/);
  assert.match(prompt, /alpha working note/);
  assert.match(prompt, /alpha session note/);
  assert.match(prompt, /alpha semantic note/);
  assert.match(prompt, /alpha procedural note/);
  assert.match(prompt, /Procedural memory is guidance only/);
});

test('PromptAssembler omits L3/L4 without memory.read', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'myclaw-prompt-'));
  const router = new MemoryRouter(makeConfig(root));
  router.write(new MemoryRecord({ layer: 'semantic', content: 'hidden semantic alpha' }), 'semantic', { permissions: [MEMORY_PERMISSIONS.WRITE] });

  const assembler = new PromptAssembler({
    config: makeConfig(root),
    toolRegistry: new ToolRegistry(),
    skillLoader: new EmptySkills(),
    pluginManager: new EmptyPlugins(),
    memoryRouter: router,
  });
  const prompt = await assembler.assemble({ session: { id: 's1', messages: [] }, userInput: 'alpha' });
  assert.doesNotMatch(prompt, /hidden semantic alpha/);
});
