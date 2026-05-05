import fs from 'node:fs';
import path from 'node:path';

const DEFAULT_LOCK_OPTIONS = {
  retries: 40,
  retryDelayMs: 25,
  staleMs: 30_000,
};

export function withFileLock(filePath, fn, options = {}) {
  const settings = { ...DEFAULT_LOCK_OPTIONS, ...options };
  const lockPath = `${filePath}.lock`;
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  acquireLock(lockPath, settings);
  try {
    return fn();
  } finally {
    releaseLock(lockPath);
  }
}

function acquireLock(lockPath, options) {
  for (let attempt = 0; attempt <= options.retries; attempt++) {
    try {
      const fd = fs.openSync(lockPath, 'wx');
      fs.writeFileSync(fd, JSON.stringify({
        pid: process.pid,
        createdAt: new Date().toISOString(),
      }));
      fs.closeSync(fd);
      return;
    } catch (err) {
      if (err.code !== 'EEXIST') throw err;
      removeStaleLock(lockPath, options.staleMs);
      if (attempt === options.retries) {
        throw new Error(`Timed out waiting for file lock: ${lockPath}`);
      }
      sleep(options.retryDelayMs);
    }
  }
}

function releaseLock(lockPath) {
  try {
    fs.unlinkSync(lockPath);
  } catch {
    // Best effort: stale lock cleanup handles leftovers.
  }
}

function removeStaleLock(lockPath, staleMs) {
  try {
    const stat = fs.statSync(lockPath);
    if (Date.now() - stat.mtimeMs > staleMs) fs.unlinkSync(lockPath);
  } catch {
    // Missing lock is fine; next acquire attempt will recreate it.
  }
}

function sleep(ms) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}
