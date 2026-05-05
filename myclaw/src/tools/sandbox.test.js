import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  canUseTool,
  createEditTool,
  createExecTool,
  createGlobTool,
  createGrepTool,
  createListFilesTool,
  createReadTool,
  createWriteTool,
  PermissionRules,
  resolveWorkspacePath,
  StreamingToolExecutor,
  ToolPolicy,
  ToolRegistry,
} from './index.js';
import { Config } from '../config/index.js';

function setup(extra = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'myclaw-sandbox-'));
  const workspace = path.join(root, 'workspace');
  const outside = path.join(root, 'outside');
  fs.mkdirSync(workspace, { recursive: true });
  fs.mkdirSync(outside, { recursive: true });
  fs.writeFileSync(path.join(workspace, 'inside.txt'), 'alpha inside text', 'utf-8');
  fs.writeFileSync(path.join(outside, 'outside.txt'), 'alpha outside text', 'utf-8');
  return {
    root,
    workspace,
    outside,
    config: {
      agent: { workspace },
      tools: {
        enabled: ['read', 'write', 'edit', 'list_files', 'grep', 'glob', 'exec'],
        policies: {
          read: 'allow',
          write: 'allow',
          edit: 'allow',
          list_files: 'allow',
          grep: 'allow',
          glob: 'allow',
          exec: 'allow',
        },
        allowExternalPaths: extra.allowExternalPaths || false,
        exec: {
          timeout: 5,
          allowedCommands: extra.allowedCommands || [],
          deniedCommands: extra.deniedCommands || [],
        },
        rules: extra.rules || [],
      },
    },
  };
}

test('relative and absolute workspace paths resolve inside workspace', () => {
  const { workspace } = setup();
  const relative = resolveWorkspacePath('inside.txt', workspace);
  const absolute = resolveWorkspacePath(path.join(workspace, 'inside.txt'), workspace);

  assert.equal(relative, path.join(workspace, 'inside.txt'));
  assert.equal(absolute, path.join(workspace, 'inside.txt'));
});

test('absolute outside paths and traversal are rejected', () => {
  const { workspace, outside } = setup();

  assert.throws(() => resolveWorkspacePath(path.join(outside, 'outside.txt'), workspace), /outside the configured workspace/);
  assert.throws(() => resolveWorkspacePath('../outside/outside.txt', workspace), /outside the configured workspace/);
});

test('read/write/edit/list_files/grep/glob reject workspace escapes', async () => {
  const { config, outside } = setup();
  const outsideFile = path.join(outside, 'outside.txt');
  const outsideWrite = path.join(outside, 'write.txt');

  assert.match(await createReadTool(config).handler({ path: outsideFile }), /Workspace sandbox denied path/);
  assert.match(await createWriteTool(config).handler({ path: outsideWrite, content: 'nope' }), /Workspace sandbox denied path/);
  assert.equal(fs.existsSync(outsideWrite), false);
  assert.match(await createEditTool(config).handler({ path: outsideFile, old_string: 'alpha', new_string: 'beta' }), /Workspace sandbox denied path/);
  assert.match(await createListFilesTool(config).handler({ path: outside }), /Workspace sandbox denied path/);
  assert.match(await createGrepTool(config).handler({ path: outside, pattern: 'alpha' }), /Workspace sandbox denied path/);
  assert.match(await createGlobTool(config).handler({ path: outside, pattern: '**/*.txt' }), /Workspace sandbox denied path/);
});

test('workspace file tools allow paths inside workspace', async () => {
  const { config, workspace } = setup();
  const insideAbsolute = path.join(workspace, 'inside.txt');

  assert.match(await createReadTool(config).handler({ path: insideAbsolute }), /alpha inside/);
  assert.match(await createWriteTool(config).handler({ path: 'nested/new.txt', content: 'created inside' }), /Written/);
  assert.match(await createEditTool(config).handler({ path: 'nested/new.txt', old_string: 'created', new_string: 'edited' }), /Edited/);
  assert.match(await createListFilesTool(config).handler({ path: 'nested' }), /new.txt/);
  assert.match(await createGrepTool(config).handler({ path: '.', pattern: 'edited inside' }), /nested/);
  assert.match(await createGlobTool(config).handler({ path: '.', pattern: '**/*.txt' }), /nested\/new.txt|nested\\new.txt/);
});

test('exec defaults cwd to workspace and rejects cwd outside workspace', async () => {
  const { config, workspace, outside } = setup({ allowedCommands: [process.execPath, 'echo'] });
  const marker = path.join(workspace, 'cwd-marker.txt');
  const command = `${process.execPath} -e "require('node:fs').writeFileSync('cwd-marker.txt','ok')"`;

  assert.match(await createExecTool(config).handler({ command }), /no output|^\s*$/i);
  assert.equal(fs.readFileSync(marker, 'utf-8'), 'ok');
  assert.match(await createExecTool(config).handler({ command: 'echo nope', cwd: outside }), /Invalid exec cwd/);
});

test('exec deniedCommands, allowedCommands, and PermissionRules pattern are enforced', async () => {
  const denied = setup({ deniedCommands: ['echo blocked*'] });
  const allowed = setup({ allowedCommands: ['echo'] });
  const ruleBlocked = setup({ rules: [{ tool: 'exec', pattern: 'echo rule*', action: 'deny' }] });

  assert.equal((await canUseExec(denied.config, 'echo blocked now')).allowed, false);
  assert.match((await canUseExec(denied.config, 'echo blocked now')).reason, /deniedCommands/);
  assert.equal((await canUseExec(allowed.config, 'echo allowed')).allowed, true);
  assert.equal((await canUseExec(allowed.config, 'node not-allowed')).allowed, false);
  assert.equal((await canUseExec(ruleBlocked.config, 'echo rule blocked')).allowed, false);
  assert.match((await canUseExec(ruleBlocked.config, 'echo rule blocked')).reason, /permission rule/);
});

test('allowExternalPaths permits external path handlers but still requires tool policy', async () => {
  const { root, outside } = setup();
  const config = setup({ allowExternalPaths: true }).config;
  config.agent.workspace = path.join(root, 'workspace');
  const outsideFile = path.join(outside, 'outside.txt');

  assert.match(await createReadTool(config).handler({ path: outsideFile }), /alpha outside/);

  const registry = new ToolRegistry();
  const read = createReadTool(config);
  registry.register(read.definition, read.handler);
  const executor = new StreamingToolExecutor(registry, new ToolPolicy({ tools: { enabled: [], policies: { read: 'deny' } } }), null, {});
  const [result] = await executor.executeAll([{
    id: 'read-denied',
    type: 'function',
    function: { name: 'read', arguments: JSON.stringify({ path: outsideFile }) },
  }]);

  assert.equal(result.denied, true);
  assert.match(result.result, /denied by policy/);
});

test('MYCLAW_HOME temporary workspace sandbox does not write to real home workspace', async () => {
  const previous = process.env.MYCLAW_HOME;
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'myclaw-sandbox-home-'));
  const marker = `sandbox-${Date.now()}-${Math.random().toString(16).slice(2)}.txt`;
  const realMarker = path.join(os.homedir(), '.myclaw', 'workspace', marker);
  deleteIfExists(realMarker);

  try {
    process.env.MYCLAW_HOME = home;
    const cfg = Config.init(Config.getConfigPath());
    fs.mkdirSync(cfg.get('agent.workspace'), { recursive: true });
    const config = {
      agent: { workspace: cfg.get('agent.workspace') },
      tools: { enabled: ['write'], policies: { write: 'allow' }, allowExternalPaths: false },
    };

    assert.match(await createWriteTool(config).handler({ path: marker, content: 'isolated' }), /Written/);
    assert.equal(fs.existsSync(path.join(home, 'workspace', marker)), true);
    assert.equal(fs.existsSync(realMarker), false);
  } finally {
    if (previous === undefined) delete process.env.MYCLAW_HOME;
    else process.env.MYCLAW_HOME = previous;
    deleteIfExists(realMarker);
  }
});

async function canUseExec(config, command) {
  const registry = new ToolRegistry();
  const tool = createExecTool(config);
  registry.register(tool.definition, tool.handler);
  return canUseTool({
    toolName: 'exec',
    args: { command },
    policy: new ToolPolicy(config),
    registry,
    plugins: null,
    rules: new PermissionRules(config),
    context: { forceAllow: true },
  });
}

function deleteIfExists(filePath) {
  if (fs.existsSync(filePath)) fs.unlinkSync(filePath);
}
