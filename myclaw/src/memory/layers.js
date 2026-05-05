import path from 'node:path';
import { MemoryRecord } from './models.js';
import { InMemoryStore } from './stores.js';
import { SessionFileStore } from './sessionStore.js';
import { MarkdownStore } from './markdownStore.js';

export class WorkingMemoryLayer {
  constructor(store = new InMemoryStore()) {
    this.layer = 'working';
    this.store = store;
  }

  put(record) { return this.store.put(new MemoryRecord({ ...record, layer: 'working' })); }
  get(id) { return this.store.get(id); }
  search(query, filters = {}, limit = 10) { return this.store.search(query, { ...filters, layer: 'working' }, limit); }
  delete(id) { return this.store.delete(id); }
  list(filters = {}, limit = 100) { return this.store.list({ ...filters, layer: 'working' }, limit); }
  clear(filters = {}) { return this.store.clear({ ...filters, layer: 'working' }); }
}

export class SessionMemoryLayer {
  constructor(memoryRoot) {
    this.layer = 'session';
    this.store = new SessionFileStore(path.join(memoryRoot, 'session'));
  }

  appendEvent(event, context = {}) {
    const record = new MemoryRecord({
      id: event.event_id || event.id,
      layer: 'session',
      namespace: event.namespace || 'session',
      scope: event.session_id || context.session_id || 'global',
      session_id: event.session_id || context.session_id || null,
      agent_id: event.agent_id || context.agent_id || null,
      user_id: event.user_id || context.user_id || null,
      lane_id: event.lane_id || context.lane_id || null,
      key: event.event_type,
      title: event.title || event.event_type || 'event',
      content: event.content || '',
      tags: event.tags || [event.event_type].filter(Boolean),
      metadata: { ...(event.metadata || {}), event_type: event.event_type },
      source: event.source || `session:${event.session_id || context.session_id || 'global'}`,
      confidence: event.confidence ?? 1,
      visibility: event.visibility || 'private',
      risk_level: event.risk_level || 'low',
    });
    return this.store.put(record);
  }

  summarizeSession(sessionId, limit = 50) {
    return this.store.list({ session_id: sessionId }, limit)
      .reverse()
      .map(record => `${record.title}: ${record.content}`)
      .join('\n');
  }

  put(record) { return this.store.put(new MemoryRecord({ ...record, layer: 'session' })); }
  get(id) { return this.store.get(id); }
  search(query, filters = {}, limit = 10) { return this.store.search(query, { ...filters, layer: 'session' }, limit); }
  delete(id) { return this.store.delete(id); }
  list(filters = {}, limit = 100) { return this.store.list({ ...filters, layer: 'session' }, limit); }
  clear(filters = {}) { return this.store.clear({ ...filters, layer: 'session' }); }
}

export class SemanticMemoryLayer {
  constructor(memoryRoot) {
    this.layer = 'semantic';
    this.store = new MarkdownStore(memoryRoot, 'semantic');
  }

  put(record) { return this.store.put(new MemoryRecord({ ...record, layer: 'semantic' })); }
  get(id) { return this.store.get(id); }
  search(query, filters = {}, limit = 10) { return this.store.search(query, { ...filters, layer: 'semantic' }, limit); }
  delete(id) { return this.store.delete(id); }
  list(filters = {}, limit = 100) { return this.store.list({ ...filters, layer: 'semantic' }, limit); }
  clear(filters = {}) { return this.store.clear({ ...filters, layer: 'semantic' }); }
  reindex() { return this.list({}, 100000).length; }
}

export class ProceduralMemoryLayer extends SemanticMemoryLayer {
  constructor(memoryRoot) {
    super(memoryRoot);
    this.layer = 'procedural';
    this.store = new MarkdownStore(memoryRoot, 'procedural');
  }

  put(record) { return this.store.put(new MemoryRecord({ ...record, layer: 'procedural' })); }
  search(query, filters = {}, limit = 10) { return this.store.search(query, { ...filters, layer: 'procedural' }, limit); }
  list(filters = {}, limit = 100) { return this.store.list({ ...filters, layer: 'procedural' }, limit); }
}
