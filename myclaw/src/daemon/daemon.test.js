import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { APPROVAL_TYPES } from '../approval/index.js';
import {
  cleanupStalePid,
  DaemonManager,
  defaultLogPath,
  defaultPidPath,
  readPidFile,
  removePidFile,
  writePidFile,
} from './index.js';

function withTempHome(fn) {
  const previousHome = process.env.MYCLAW_HOME;
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'myclaw-daemon-'));
  process.env.MYCLAW_HOME = path.join(root, 'home');
  return Promise.resolve()
    .then(() => fn({ root, home: process.env.MYCLAW_HOME }))
    .finally(() => {
      if (previousHome === undefined) delete process.env.MYCLAW_HOME;
      else process.env.MYCLAW_HOME = previousHome;
      fs.rmSync(root, { recursive: true, force: true });
    });
}

function daemonConfig(root, extra = {}) {
  return {
    gateway: {
      host: '127.0.0.1',
      port: 0,
      adminToken: extra.adminToken ?? '',
      ...(extra.gateway || {}),
    },
    agent: { name: 'myclaw', workspace: path.join(root, 'workspace'), streaming: false, maxIterations: 1 },
    provider: { type: 'openai', model: 'fake', maxTokens: 2048 },
    tools: {
      enabled: extra.toolsEnabled || [],
      exec: { timeout: 1, allowedCommands: [], deniedCommands: [] },
    },
    memory: { root: path.join(root, 'memory'), runtimePermissions: [], toolPermissions: [] },
    audit: { rotation: { enabled: true, maxSizeBytes: 1024 * 1024, maxFiles: 2 } },
    approval: { mode: 'manual' },
    daemon: extra.daemon || {},
  };
}

async function api(baseUrl, pathname, options = {}) {
  const headers = {};
  if (options.token) headers.Authorization = `Bearer ${options.token}`;
  const response = await fetch(`${baseUrl}${pathname}`, { method: options.method || 'GET', headers });
  const text = await response.text();
  return { status: response.status, body: text ? JSON.parse(text) : null };
}

test('pid file create and remove use MYCLAW_HOME run path', async () => {
  await withTempHome(async ({ home }) => {
    const pidFile = defaultPidPath({});
    const logFile = defaultLogPath({});
    const record = writePidFile(pidFile, { pid: process.pid, gateway: { host: '127.0.0.1', port: 3456 }, logFile });

    assert.equal(pidFile, path.join(home, 'run', 'myclaw.pid'));
    assert.equal(logFile, path.join(home, 'logs', 'daemon.log'));
    assert.equal(readPidFile(pidFile).pid, process.pid);
    assert.equal(record.schemaVersion, 1);
    assert.equal(removePidFile(pidFile), true);
    assert.equal(readPidFile(pidFile), null);
  });
});

test('stale pid cleanup removes dead pid file', async () => {
  await withTempHome(async () => {
    const pidFile = defaultPidPath({});
    writePidFile(pidFile, { pid: 99999999 });

    const result = cleanupStalePid(pidFile);

    assert.equal(result.stale, true);
    assert.equal(result.removed, true);
    assert.equal(fs.existsSync(pidFile), false);
  });
});

test('daemon status reports not running without pid file', async () => {
  await withTempHome(async ({ root }) => {
    const manager = new DaemonManager(daemonConfig(root));
    const status = manager.status();

    assert.equal(status.running, false);
    assert.equal(status.stale, false);
    assert.equal(status.pid, null);
    assert.match(status.pidFile, /myclaw\.pid$/);
  });
});

test('daemon status reports running when pid exists', async () => {
  await withTempHome(async ({ root }) => {
    const manager = new DaemonManager(daemonConfig(root));
    writePidFile(manager.pidFile, { pid: process.pid, gateway: { host: '127.0.0.1', port: 1234 } });

    const status = manager.status();

    assert.equal(status.running, true);
    assert.equal(status.pid, process.pid);
    assert.equal(status.gatewayPort, 1234);
  });
});

test('daemon start refuses duplicate live pid', async () => {
  await withTempHome(async ({ root }) => {
    const manager = new DaemonManager(daemonConfig(root));
    writePidFile(manager.pidFile, { pid: process.pid });

    await assert.rejects(() => manager.start(), /already running/);
  });
});

test('daemon refuses public host without admin token', async () => {
  await withTempHome(async ({ root }) => {
    const manager = new DaemonManager(daemonConfig(root, { gateway: { host: '0.0.0.0' } }));

    await assert.rejects(() => manager.start(), /public host without/);
  });
});

test('daemon starts gateway and keeps management API token-gated', async () => {
  await withTempHome(async ({ root }) => {
    const manager = new DaemonManager(daemonConfig(root, { adminToken: '' }));
    const status = await manager.start();
    const baseUrl = `http://127.0.0.1:${status.gatewayPort}`;

    try {
      const health = await api(baseUrl, '/api/health');
      const audit = await api(baseUrl, '/api/audit');

      assert.equal(health.status, 200);
      assert.equal(health.body.status, 'ok');
      assert.equal(audit.status, 403);
      assert.equal(manager.status().running, true);
    } finally {
      await manager.stop();
    }
  });
});

test('daemon start does not execute tools or auto-approve approvals', async () => {
  await withTempHome(async ({ root }) => {
    const manager = new DaemonManager(daemonConfig(root, { adminToken: 'token', toolsEnabled: ['exec'] }));
    await manager.start();

    try {
      const request = manager.gateway.engine.approvalBroker.submit({
        type: APPROVAL_TYPES.TOOL_CALL,
        toolName: 'exec',
        subject: 'exec',
        action: 'execute',
        reason: 'manual approval required',
      }, { session_id: 's1', user_id: 'u1', agent_id: 'a1' });

      assert.equal(manager.gateway.engine.approvalBroker.get(request.id).status, 'pending');
      assert.equal(manager.gateway.engine.auditLog.query({ eventType: 'tool.execution.start', limit: 10 }).length, 0);
    } finally {
      await manager.stop();
    }
  });
});

test('daemon stop cleans stale pid and removes current foreground pid', async () => {
  await withTempHome(async ({ root }) => {
    const staleManager = new DaemonManager(daemonConfig(root));
    writePidFile(staleManager.pidFile, { pid: 99999999 });

    const staleStop = await staleManager.stop();
    assert.equal(staleStop.stale, true);
    assert.equal(fs.existsSync(staleManager.pidFile), false);

    const currentManager = new DaemonManager(daemonConfig(root));
    writePidFile(currentManager.pidFile, { pid: process.pid });

    const currentStop = await currentManager.stop();
    assert.equal(currentStop.stopped, true);
    assert.equal(fs.existsSync(currentManager.pidFile), false);
  });
});
