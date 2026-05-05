import fs from 'node:fs';
import path from 'node:path';
import { withFileLock } from './fileLock.js';

const DEFAULT_ROTATION = {
  enabled: true,
  maxSizeBytes: 10 * 1024 * 1024,
  maxFiles: 5,
};

export function appendJsonl(filePath, event, options = {}) {
  return withFileLock(filePath, () => {
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    rotateJsonlIfNeeded(filePath, options.rotation);
    fs.appendFileSync(filePath, `${JSON.stringify(event)}\n`, 'utf-8');
  }, options.lock);
}

export function readJsonlTail(filePath, lines = 20) {
  if (!fs.existsSync(filePath)) return [];
  const count = Number.isFinite(Number(lines)) ? Number(lines) : 20;
  return fs.readFileSync(filePath, 'utf-8')
    .split(/\r?\n/)
    .filter(Boolean)
    .slice(-Math.max(0, count))
    .map(line => {
      try {
        return JSON.parse(line);
      } catch {
        return null;
      }
    })
    .filter(Boolean);
}

export function rotateJsonlIfNeeded(filePath, options = {}) {
  const settings = { ...DEFAULT_ROTATION, ...(options || {}) };
  if (!settings.enabled) return false;
  if (!fs.existsSync(filePath)) return false;
  const maxSizeBytes = Math.max(1, settings.maxSizeBytes || DEFAULT_ROTATION.maxSizeBytes);
  if (fs.statSync(filePath).size < maxSizeBytes) return false;

  const maxFiles = Math.max(1, settings.maxFiles || DEFAULT_ROTATION.maxFiles);
  for (let index = maxFiles; index >= 1; index--) {
    const rotated = `${filePath}.${index}`;
    if (!fs.existsSync(rotated)) continue;
    if (index === maxFiles) fs.unlinkSync(rotated);
    else fs.renameSync(rotated, `${filePath}.${index + 1}`);
  }
  fs.renameSync(filePath, `${filePath}.1`);
  return true;
}
