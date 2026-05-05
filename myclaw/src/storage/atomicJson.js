import fs from 'node:fs';
import path from 'node:path';
import { withFileLock } from './fileLock.js';

export function atomicWriteJson(filePath, data, options = {}) {
  const payload = JSON.stringify(data, null, options.space ?? 2) + '\n';
  return atomicWriteText(filePath, payload, options);
}

export function atomicWriteText(filePath, text, options = {}) {
  if (options.enabled === false) {
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    fs.writeFileSync(filePath, text, 'utf-8');
    return;
  }
  return withFileLock(filePath, () => {
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    const tempPath = `${filePath}.tmp.${process.pid}.${Date.now()}.${Math.random().toString(16).slice(2)}`;
    try {
      fs.writeFileSync(tempPath, text, 'utf-8');
      fs.renameSync(tempPath, filePath);
    } catch (err) {
      try {
        if (fs.existsSync(tempPath)) fs.unlinkSync(tempPath);
      } catch {
        // Ignore cleanup failure; the destination was not replaced.
      }
      throw err;
    }
  }, options.lock);
}

export function readJsonSafe(filePath, defaultValue = null, options = {}) {
  if (!fs.existsSync(filePath)) return cloneDefault(defaultValue);
  try {
    return JSON.parse(fs.readFileSync(filePath, 'utf-8'));
  } catch {
    if (options.backupCorrupt !== false) backupCorruptFile(filePath);
    return cloneDefault(defaultValue);
  }
}

export function backupCorruptFile(filePath) {
  if (!fs.existsSync(filePath)) return null;
  const backupPath = `${filePath}.corrupt.${timestampForFile()}`;
  try {
    fs.renameSync(filePath, backupPath);
    return backupPath;
  } catch {
    try {
      fs.copyFileSync(filePath, backupPath);
      return backupPath;
    } catch {
      return null;
    }
  }
}

function cloneDefault(value) {
  if (value === null || value === undefined) return value;
  return JSON.parse(JSON.stringify(value));
}

function timestampForFile() {
  return new Date().toISOString().replace(/[:.]/g, '-');
}
