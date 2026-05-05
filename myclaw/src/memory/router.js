import os from 'node:os';
import path from 'node:path';
import { MemoryRecord, MemorySearchResult } from './models.js';
import { trimToBudget } from './budget.js';
import { MemoryPolicyGate } from './policy.js';
import {
  ProceduralMemoryLayer,
  SemanticMemoryLayer,
  SessionMemoryLayer,
  WorkingMemoryLayer,
} from './layers.js';

export function defaultMemoryRoot(config = {}) {
  if (config.memory?.root) return expandHome(config.memory.root);
  const home = process.env.MYCLAW_HOME || path.join(os.homedir(), '.myclaw');
  return path.join(home, 'memory');
}

export class MemoryRouter {
  constructor(config = {}, options = {}) {
    this.config = config;
    this.memoryRoot = options.memoryRoot || defaultMemoryRoot(config);
    this.auditLog = options.auditLog || null;
    this.policyGate = options.policyGate || new MemoryPolicyGate({ toolPolicy: options.toolPolicy });
    this.working = options.working || new WorkingMemoryLayer();
    this.session = options.session || new SessionMemoryLayer(this.memoryRoot);
    this.semantic = options.semantic || new SemanticMemoryLayer(this.memoryRoot);
    this.procedural = options.procedural || new ProceduralMemoryLayer(this.memoryRoot);
    this.layers = {
      working: this.working,
      session: this.session,
      semantic: this.semantic,
      procedural: this.procedural,
    };
  }

  write(record, requestedLayer = null, context = {}) {
    const layer = requestedLayer || record.layer;
    const next = new MemoryRecord({ ...record, layer });
    try {
      this.policyGate.enforceWrite(next, context);
    } catch (err) {
      this._auditMemory('memory.write.deny', next, context, {
        decision: 'deny',
        reason: err.message,
        permission: permissionForWrite(layer),
      });
      throw err;
    }
    const saved = this.layers[layer].put(next);
    this._auditMemory('memory.write.allow', saved, context, {
      decision: 'allow',
      reason: 'memory write allowed',
      permission: permissionForWrite(layer),
    });
    return saved;
  }

  retrieve(query, context = {}, options = {}) {
    const layerNames = options.layers || ['working', 'session', 'semantic', 'procedural'];
    const limit = options.limit || 10;
    const filters = filtersFromContext(context);
    const results = [];

    for (const layerName of layerNames) {
      if (!this.policyGate.canRead(layerName, context)) continue;
      const remaining = limit - results.length;
      if (remaining <= 0) break;
      const layerFilters = { ...filters };
      if (layerName !== 'working') delete layerFilters.lane_id;
      for (const result of this.layers[layerName].search(query, layerFilters, remaining)) {
        results.push(new MemorySearchResult({
          record: result.record,
          score: result.score,
          source: result.source,
          reason: `${layerName}: ${result.reason}`,
        }));
      }
    }

    return trimToBudget(results.slice(0, limit), options.budgetChars || options.budget_tokens || options.budgetTokens);
  }

  retrieveForPrompt(query, context = {}, options = {}) {
    return this.retrieve(query, context, options);
  }

  delete(id, context = {}) {
    for (const layer of Object.values(this.layers)) {
      const record = layer.get(id);
      if (!record) continue;
      try {
        this.policyGate.enforceDelete(record, context);
      } catch (err) {
        this._auditMemory('memory.delete.deny', record, context, {
          decision: 'deny',
          reason: err.message,
          permission: 'memory.delete',
        });
        throw err;
      }
      const deleted = layer.delete(id);
      this._auditMemory('memory.delete.allow', record, context, {
        decision: 'allow',
        reason: deleted ? 'memory delete allowed' : 'memory delete no-op',
        permission: 'memory.delete',
      });
      return deleted;
    }
    return false;
  }

  reindex(layer = null, context = {}) {
    const targets = layer ? [layer] : ['semantic', 'procedural'];
    const counts = {};
    for (const name of targets) {
      try {
        this.policyGate.enforceReindex(name, context);
      } catch (err) {
        this._auditMemory('memory.reindex.deny', { layer: name, id: name }, context, {
          decision: 'deny',
          reason: err.message,
          permission: 'memory.reindex',
        });
        throw err;
      }
      counts[name] = this.layers[name].reindex?.() || 0;
      this._auditMemory('memory.reindex.allow', { layer: name, id: name }, context, {
        decision: 'allow',
        reason: 'memory reindex allowed',
        permission: 'memory.reindex',
        metadata: { count: counts[name] },
      });
    }
    return counts;
  }

  appendSessionEvent(event, context = {}) {
    this.policyGate.enforceWrite(new MemoryRecord({ layer: 'session' }), context);
    return this.session.appendEvent(event, context);
  }

  retrieveSessionEvents(sessionId, context = {}, options = {}) {
    if (!this.policyGate.canRead('session', context)) return [];
    const filters = { ...filtersFromContext(context), session_id: sessionId || context.session_id };
    delete filters.lane_id;
    return this.session.list(filters, options.limit || 100);
  }

  _auditMemory(eventType, record, context = {}, details = {}) {
    if (!this.auditLog || !shouldAuditMemory(record?.layer)) return;
    this.auditLog.write({
      eventType,
      subject: record?.id || record?.key || '',
      subjectRole: 'memory',
      sessionId: context.session_id || record?.session_id || null,
      userId: context.user_id || record?.user_id || null,
      agentId: context.agent_id || record?.agent_id || null,
      action: eventType,
      resource: record?.layer || '',
      permission: details.permission || null,
      decision: details.decision || null,
      reason: details.reason || '',
      riskLevel: record?.risk_level || 'low',
      metadata: {
        layer: record?.layer,
        namespace: record?.namespace,
        key: record?.key,
        ...(details.metadata || {}),
      },
      source: 'memory-router',
    });
  }
}

function shouldAuditMemory(layer) {
  return ['semantic', 'procedural'].includes(layer);
}

function permissionForWrite(layer) {
  if (layer === 'semantic') return 'memory.write';
  if (layer === 'procedural') return 'memory.procedural.write';
  return null;
}

export function filtersFromContext(context = {}) {
  const filters = {};
  for (const key of ['namespace', 'scope', 'session_id', 'agent_id', 'user_id', 'lane_id']) {
    if (context[key] !== undefined && context[key] !== null) filters[key] = context[key];
  }
  return filters;
}

function expandHome(value) {
  if (!value || !value.startsWith('~')) return value;
  return path.join(os.homedir(), value.slice(1));
}
