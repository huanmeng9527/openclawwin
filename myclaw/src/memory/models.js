import crypto from 'node:crypto';

export const MEMORY_LAYERS = ['working', 'session', 'semantic', 'procedural'];

export function nowIso() {
  return new Date().toISOString();
}

export function createId(prefix = 'mem') {
  return `${prefix}_${crypto.randomBytes(8).toString('hex')}`;
}

export class MemoryRecord {
  constructor(data = {}) {
    if (!data.layer || !MEMORY_LAYERS.includes(data.layer)) {
      throw new Error(`Invalid memory layer: ${data.layer}`);
    }

    this.id = data.id || createId(data.layer);
    this.layer = data.layer;
    this.namespace = data.namespace || 'default';
    this.scope = data.scope || 'global';
    this.session_id = data.session_id || null;
    this.agent_id = data.agent_id || null;
    this.user_id = data.user_id || null;
    this.lane_id = data.lane_id || null;
    this.key = data.key || null;
    this.title = data.title || '';
    this.content = data.content || '';
    this.tags = Array.from(new Set(data.tags || []));
    this.metadata = data.metadata || {};
    this.source = data.source || '';
    this.confidence = data.confidence ?? 1;
    this.created_at = data.created_at || nowIso();
    this.updated_at = data.updated_at || nowIso();
    this.expires_at = data.expires_at || null;
    this.visibility = data.visibility || 'private';
    this.risk_level = data.risk_level || 'low';
  }

  toJSON() {
    return {
      id: this.id,
      layer: this.layer,
      namespace: this.namespace,
      scope: this.scope,
      session_id: this.session_id,
      agent_id: this.agent_id,
      user_id: this.user_id,
      lane_id: this.lane_id,
      key: this.key,
      title: this.title,
      content: this.content,
      tags: this.tags,
      metadata: this.metadata,
      source: this.source,
      confidence: this.confidence,
      created_at: this.created_at,
      updated_at: this.updated_at,
      expires_at: this.expires_at,
      visibility: this.visibility,
      risk_level: this.risk_level,
    };
  }
}

export class MemorySearchResult {
  constructor({ record, score = 0, source = '', reason = '' }) {
    this.record = record instanceof MemoryRecord ? record : new MemoryRecord(record);
    this.layer = this.record.layer;
    this.score = score;
    this.source = source || this.record.source;
    this.reason = reason;
  }

  toJSON() {
    return {
      record: this.record.toJSON(),
      layer: this.layer,
      score: this.score,
      source: this.source,
      reason: this.reason,
    };
  }
}
