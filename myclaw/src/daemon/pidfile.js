import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { atomicWriteJson, readJsonSafe } from '../storage/index.js';

export const DAEMON_PID_SCHEMA_VERSION = 1;

export function defaultDaemonRunDir(config = {}) {
  return path.join(getMyClawHome(config), 'run');
}

export function defaultDaemonLogDir(config = {}) {
  return path.join(getMyClawHome(config), 'logs');
}

export function defaultPidPath(config = {}) {
  if (config.daemon?.pidFile) return expandHome(config.daemon.pidFile);
  return path.join(defaultDaemonRunDir(config), 'myclaw.pid');
}

export function defaultLogPath(config = {}) {
  if (config.daemon?.logFile) return expandHome(config.daemon.logFile);
  return path.join(defaultDaemonLogDir(config), 'daemon.log');
}

export function readPidFile(filePath) {
  if (!fs.existsSync(filePath)) return null;
  const data = readJsonSafe(filePath, null);
  if (data === null || data === undefined) return null;
  if (typeof data === 'number' || typeof data === 'string') {
    const pid = Number.parseInt(data, 10);
    return Number.isFinite(pid) ? { schemaVersion: 0, pid } : null;
  }
  if (typeof data !== 'object') return null;
  const pid = Number.parseInt(data.pid, 10);
  if (!Number.isFinite(pid) || pid <= 0) return null;
  return {
    schemaVersion: data.schemaVersion || 0,
    pid,
    startedAt: data.startedAt || null,
    gateway: data.gateway || {},
    myclawHome: data.myclawHome || null,
    logFile: data.logFile || null,
  };
}

export function writePidFile(filePath, data = {}, options = {}) {
  const record = {
    schemaVersion: DAEMON_PID_SCHEMA_VERSION,
    pid: Number.parseInt(data.pid || process.pid, 10),
    startedAt: data.startedAt || new Date().toISOString(),
    gateway: data.gateway || {},
    myclawHome: data.myclawHome || getMyClawHome(options.config || {}),
    logFile: data.logFile || null,
  };
  atomicWriteJson(filePath, record, storageOptions(options.config || {}));
  return record;
}

export function removePidFile(filePath) {
  try {
    if (fs.existsSync(filePath)) fs.unlinkSync(filePath);
    return true;
  } catch {
    return false;
  }
}

export function isPidRunning(pid) {
  const parsed = Number.parseInt(pid, 10);
  if (!Number.isFinite(parsed) || parsed <= 0) return false;
  try {
    process.kill(parsed, 0);
    return true;
  } catch (err) {
    return err.code === 'EPERM';
  }
}

export function cleanupStalePid(filePath) {
  const record = readPidFile(filePath);
  if (!record) return { stale: false, removed: false, record: null };
  if (isPidRunning(record.pid)) return { stale: false, removed: false, record };
  return { stale: true, removed: removePidFile(filePath), record };
}

export function getMyClawHome(config = {}) {
  if (config.home) return path.resolve(expandHome(config.home));
  const configuredHome = config.runtime?.home || config.myclawHome;
  if (configuredHome) return path.resolve(expandHome(configuredHome));
  return path.resolve(process.env.MYCLAW_HOME || path.join(os.homedir(), '.myclaw'));
}

function expandHome(value) {
  if (!value || typeof value !== 'string' || !value.startsWith('~')) return value;
  if (value === '~') return os.homedir();
  if (value.startsWith('~/') || value.startsWith(`~${path.sep}`)) {
    return path.join(os.homedir(), value.slice(2));
  }
  return value;
}

function storageOptions(config = {}) {
  return {
    enabled: config.storage?.atomicWrites?.enabled !== false,
  };
}
