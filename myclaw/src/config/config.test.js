import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { initCommand } from '../cli/commands/init.js';
import { Config, getDefaultWorkspace } from './index.js';
import { defaultMemoryRoot, MemoryRouter } from '../memory/index.js';
import { SessionManager } from '../session/index.js';

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');

function withMyclawHome(value, fn) {
  const previous = process.env.MYCLAW_HOME;
  if (value === undefined) delete process.env.MYCLAW_HOME;
  else process.env.MYCLAW_HOME = value;
  try {
    return fn();
  } finally {
    if (previous === undefined) delete process.env.MYCLAW_HOME;
    else process.env.MYCLAW_HOME = previous;
  }
}

function tmpRoot(name) {
  return fs.mkdtempSync(path.join(os.tmpdir(), `myclaw-${name}-`));
}

function snapshotPath(target) {
  if (!fs.existsSync(target)) return null;
  const stat = fs.statSync(target);
  if (!stat.isDirectory()) return { type: 'file', size: stat.size, mtimeMs: stat.mtimeMs };
  return {
    type: 'dir',
    entries: fs.readdirSync(target).sort().map(entry => {
      const entryPath = path.join(target, entry);
      const entryStat = fs.statSync(entryPath);
      return {
        name: entry,
        isDirectory: entryStat.isDirectory(),
        size: entryStat.size,
        mtimeMs: entryStat.mtimeMs,
      };
    }),
  };
}

function silenceConsole(fn) {
  const original = {
    log: console.log,
    warn: console.warn,
    error: console.error,
  };
  console.log = () => {};
  console.warn = () => {};
  console.error = () => {};
  try {
    return fn();
  } finally {
    console.log = original.log;
    console.warn = original.warn;
    console.error = original.error;
  }
}

test('defaults use ~/.myclaw when MYCLAW_HOME is unset', () => withMyclawHome(undefined, () => {
  assert.equal(Config.getConfigDir(), path.join(os.homedir(), '.myclaw'));
  assert.equal(Config.getConfigPath(), path.join(os.homedir(), '.myclaw', 'myclaw.json'));
  assert.equal(getDefaultWorkspace(), '~/.myclaw/workspace');
}));

test('MYCLAW_HOME routes config, sessions, memory, and default workspace', () => {
  const home = tmpRoot('home-routing');
  withMyclawHome(home, () => {
    const cfg = Config.init(Config.getConfigPath());
    const sessions = new SessionManager();
    const router = new MemoryRouter({});

    assert.equal(Config.getConfigPath(), path.join(home, 'myclaw.json'));
    assert.equal(cfg.get('agent.workspace'), path.join(home, 'workspace'));
    assert.equal(sessions.dir, path.join(home, 'sessions'));
    assert.equal(defaultMemoryRoot({}), path.join(home, 'memory'));
    assert.equal(router.memoryRoot, path.join(home, 'memory'));
  });
});

test('explicit workspace is not overwritten by MYCLAW_HOME', () => {
  const home = tmpRoot('explicit-home');
  const explicitWorkspace = path.join(tmpRoot('explicit-workspace'), 'custom-workspace');
  const configPath = path.join(home, 'myclaw.json');
  fs.mkdirSync(home, { recursive: true });
  fs.writeFileSync(configPath, JSON.stringify({
    agent: { workspace: explicitWorkspace },
  }), 'utf-8');

  withMyclawHome(home, () => {
    const cfg = new Config(configPath).load();
    assert.equal(cfg.get('agent.workspace'), explicitWorkspace);
  });
});

test('init under temporary MYCLAW_HOME does not touch real ~/.myclaw workspace', () => {
  const home = tmpRoot('init-isolation');
  const realWorkspace = path.join(os.homedir(), '.myclaw', 'workspace');
  const before = snapshotPath(realWorkspace);

  withMyclawHome(home, () => {
    silenceConsole(() => initCommand({ force: true }));
    const configPath = path.join(home, 'myclaw.json');
    const workspace = path.join(home, 'workspace');
    const config = JSON.parse(fs.readFileSync(configPath, 'utf-8'));

    assert.equal(config.agent.workspace, workspace);
    assert.equal(fs.existsSync(path.join(workspace, 'AGENTS.md')), true);
    assert.equal(fs.existsSync(path.join(workspace, 'SOUL.md')), true);
  });

  assert.deepEqual(snapshotPath(realWorkspace), before);
});

test('memory smoke runs with temporary MYCLAW_HOME without touching real ~/.myclaw workspace', () => {
  const home = tmpRoot('smoke-isolation');
  const realWorkspace = path.join(os.homedir(), '.myclaw', 'workspace');
  const before = snapshotPath(realWorkspace);
  const result = spawnSync(process.execPath, ['scripts/memory-smoke.js'], {
    cwd: projectRoot,
    env: { ...process.env, MYCLAW_HOME: home },
    encoding: 'utf-8',
  });

  assert.equal(result.status, 0, result.stderr || result.stdout);
  assert.match(result.stdout, /"ok": true/);
  assert.deepEqual(snapshotPath(realWorkspace), before);
});
