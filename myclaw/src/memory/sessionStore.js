import fs from 'node:fs';
import path from 'node:path';
import { MemoryRecord, MemorySearchResult, nowIso } from './models.js';
import { MemoryStore, matchesFilters, normalizeQuery, scoreRecord, sortSearchItems } from './stores.js';
import { atomicWriteJson, readJsonSafe } from '../storage/index.js';

export class SessionFileStore extends MemoryStore {
  constructor(rootDir) {
    super();
    this.rootDir = rootDir;
    fs.mkdirSync(this.rootDir, { recursive: true });
  }

  put(record) {
    const next = record instanceof MemoryRecord ? record : new MemoryRecord(record);
    next.updated_at = nowIso();
    const records = this._readSession(next.session_id || 'global');
    const index = records.findIndex(item => item.id === next.id);
    if (index >= 0) records[index] = next;
    else records.push(next);
    this._writeSession(next.session_id || 'global', records);
    return next;
  }

  get(id) {
    for (const file of this._files()) {
      const records = this._readFile(file);
      const record = records.find(item => item.id === id);
      if (record) return record;
    }
    return null;
  }

  search(query, filters = {}, limit = 10) {
    const tokens = normalizeQuery(query);
    return this.list(filters, 100000)
      .map(record => ({ record, score: scoreRecord(record, tokens), source: record.source || `session:${record.session_id}` }))
      .filter(item => tokens.length === 0 || item.score > 0)
      .sort(sortSearchItems)
      .slice(0, limit)
      .map(item => new MemorySearchResult({
        ...item,
        reason: tokens.length ? 'session keyword match' : 'recent session event',
      }));
  }

  delete(id) {
    for (const file of this._files()) {
      const records = this._readFile(file);
      const next = records.filter(item => item.id !== id);
      if (next.length !== records.length) {
        atomicWriteJson(file, next.map(item => item.toJSON()));
        return true;
      }
    }
    return false;
  }

  list(filters = {}, limit = 100) {
    const records = [];
    for (const file of this._files()) {
      for (const record of this._readFile(file)) {
        if (matchesFilters(record, filters)) records.push(record);
      }
    }
    return records
      .sort((a, b) => b.updated_at.localeCompare(a.updated_at))
      .slice(0, limit);
  }

  clear(filters = {}) {
    const records = this.list(filters, 100000);
    for (const record of records) this.delete(record.id);
    return records.length;
  }

  _readSession(sessionId) {
    return this._readFile(this._path(sessionId));
  }

  _writeSession(sessionId, records) {
    atomicWriteJson(this._path(sessionId), records.map(item => item.toJSON()));
  }

  _path(sessionId) {
    return path.join(this.rootDir, `${safeName(sessionId)}.json`);
  }

  _files() {
    if (!fs.existsSync(this.rootDir)) return [];
    return fs.readdirSync(this.rootDir)
      .filter(file => file.endsWith('.json'))
      .map(file => path.join(this.rootDir, file));
  }

  _readFile(file) {
    if (!fs.existsSync(file)) return [];
    const data = readJsonSafe(file, []);
    return (Array.isArray(data) ? data : []).map(item => new MemoryRecord(item));
  }
}

function safeName(value) {
  return String(value || 'global').replace(/[^a-zA-Z0-9_.-]/g, '_');
}
