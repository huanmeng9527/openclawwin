import os from 'node:os';
import path from 'node:path';
import { AuditEvent } from './models.js';
import { appendJsonl, readJsonlTail } from '../storage/index.js';

export function defaultAuditPath(config = {}) {
  if (config.audit?.path) return expandHome(config.audit.path);
  const home = process.env.MYCLAW_HOME || path.join(os.homedir(), '.myclaw');
  return path.join(home, 'audit', 'audit.log');
}

export class AuditLog {
  constructor(config = {}, options = {}) {
    this.config = config;
    this.filePath = options.filePath || defaultAuditPath(config);
    this.eventBus = options.eventBus || null;
    this.rotation = {
      enabled: config.audit?.rotation?.enabled ?? true,
      maxSizeBytes: config.audit?.rotation?.maxSizeBytes || 10 * 1024 * 1024,
      maxFiles: config.audit?.rotation?.maxFiles || 5,
      ...(options.rotation || {}),
    };
  }

  write(event) {
    const next = event instanceof AuditEvent ? event : new AuditEvent(event);
    appendJsonl(this.filePath, next.toJSON(), { rotation: this.rotation });
    this.eventBus?.publish?.({
      type: 'audit.event',
      source: next.source || 'audit-log',
      sessionId: next.sessionId,
      userId: next.userId,
      agentId: next.agentId,
      approvalId: next.approvalId,
      toolName: next.toolName,
      decision: next.decision,
      riskLevel: next.riskLevel,
      summary: next.reason || next.eventType,
      metadata: {
        auditEventId: next.id,
        eventType: next.eventType,
        subject: next.subject,
        subjectRole: next.subjectRole,
        action: next.action,
        resource: next.resource,
        permission: next.permission,
      },
    });
    return next;
  }

  query(filters = {}) {
    const limit = filters.limit || 100;
    const events = this._readAll()
      .filter(event => matchesFilters(event, filters))
      .sort((a, b) => b.timestamp.localeCompare(a.timestamp));
    return events.slice(0, limit);
  }

  _readAll() {
    return readJsonlTail(this.filePath, Number.MAX_SAFE_INTEGER)
      .map(item => new AuditEvent(item))
      .filter(Boolean);
  }
}

function matchesFilters(event, filters = {}) {
  for (const key of ['eventType', 'sessionId', 'userId', 'agentId', 'toolName', 'decision', 'approvalId']) {
    if (filters[key] !== undefined && filters[key] !== null && event[key] !== filters[key]) return false;
  }
  if (filters.since && new Date(event.timestamp).getTime() < new Date(filters.since).getTime()) return false;
  if (filters.until && new Date(event.timestamp).getTime() > new Date(filters.until).getTime()) return false;
  return true;
}

function expandHome(value) {
  if (!value || !value.startsWith('~')) return value;
  if (value === '~') return os.homedir();
  if (value.startsWith('~/') || value.startsWith(`~${path.sep}`)) {
    return path.join(os.homedir(), value.slice(2));
  }
  return value;
}
