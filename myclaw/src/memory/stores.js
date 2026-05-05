import { MemoryRecord, MemorySearchResult, nowIso } from './models.js';

export class MemoryStore {
  put(_record) { throw new Error('put() not implemented'); }
  get(_id) { throw new Error('get() not implemented'); }
  search(_query, _filters = {}, _limit = 10) { throw new Error('search() not implemented'); }
  delete(_id) { throw new Error('delete() not implemented'); }
  list(_filters = {}, _limit = 100) { throw new Error('list() not implemented'); }
  clear(_filters = {}) { throw new Error('clear() not implemented'); }
}

export class InMemoryStore extends MemoryStore {
  constructor() {
    super();
    this.records = new Map();
  }

  put(record) {
    const next = record instanceof MemoryRecord ? record : new MemoryRecord(record);
    next.updated_at = nowIso();
    this.records.set(next.id, next);
    return next;
  }

  get(id) {
    const record = this.records.get(id) || null;
    if (record && isExpired(record)) {
      this.records.delete(id);
      return null;
    }
    return record;
  }

  search(query, filters = {}, limit = 10) {
    const q = normalizeQuery(query);
    return this.list(filters, 100000)
      .map(record => ({ record, score: scoreRecord(record, q), source: record.source || 'working-memory' }))
      .filter(item => q.length === 0 || item.score > 0)
      .sort(sortSearchItems)
      .slice(0, limit)
      .map(item => new MemorySearchResult({
        ...item,
        reason: q.length ? 'keyword match' : 'recent memory',
      }));
  }

  delete(id) {
    return this.records.delete(id);
  }

  list(filters = {}, limit = 100) {
    const records = [];
    for (const [id, record] of this.records.entries()) {
      if (isExpired(record)) {
        this.records.delete(id);
        continue;
      }
      if (matchesFilters(record, filters)) records.push(record);
    }
    return records
      .sort((a, b) => b.updated_at.localeCompare(a.updated_at))
      .slice(0, limit);
  }

  clear(filters = {}) {
    const ids = this.list(filters, 100000).map(record => record.id);
    for (const id of ids) this.records.delete(id);
    return ids.length;
  }
}

export function normalizeQuery(query) {
  return String(query || '')
    .toLowerCase()
    .split(/\s+/)
    .map(token => token.trim())
    .filter(Boolean);
}

export function scoreRecord(record, tokens) {
  if (tokens.length === 0) return 0;
  const haystack = [
    record.title,
    record.key,
    record.content,
    ...(record.tags || []),
    JSON.stringify(record.metadata || {}),
  ].join(' ').toLowerCase();

  let score = 0;
  for (const token of tokens) {
    if (haystack.includes(token)) score += 1;
    score += countOccurrences(haystack, token);
  }
  return score;
}

export function matchesFilters(record, filters = {}) {
  for (const [key, expected] of Object.entries(filters)) {
    if (expected === undefined || expected === null) continue;
    if (key === 'tags') {
      const tags = new Set(record.tags || []);
      const expectedTags = Array.isArray(expected) ? expected : [expected];
      if (!expectedTags.every(tag => tags.has(tag))) return false;
      continue;
    }
    if (['skill_name', 'tool_name', 'capability'].includes(key)) {
      if (record.metadata?.[key] !== expected) return false;
      continue;
    }
    const actual = record[key] ?? record.metadata?.[key] ?? null;
    if (Array.isArray(expected)) {
      if (actual !== null && !expected.includes(actual)) return false;
    } else if (actual !== null && actual !== expected) {
      return false;
    }
  }
  return true;
}

export function sortSearchItems(a, b) {
  if (b.score !== a.score) return b.score - a.score;
  return b.record.updated_at.localeCompare(a.record.updated_at);
}

function countOccurrences(text, token) {
  if (!token) return 0;
  return text.split(token).length - 1;
}

function isExpired(record) {
  return record.expires_at && new Date(record.expires_at).getTime() <= Date.now();
}
