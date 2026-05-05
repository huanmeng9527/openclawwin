import {
  APPROVAL_PERMISSIONS,
  APPROVAL_STATUS,
  APPROVAL_TYPES,
  ApprovalPermissionError,
  ApprovalRequest,
} from './models.js';
import os from 'node:os';
import path from 'node:path';
import { atomicWriteJson, readJsonSafe } from '../storage/index.js';

export function defaultApprovalPath(config = {}) {
  if (config.approval?.path) return expandHome(config.approval.path);
  if (config.approvals?.path) return expandHome(config.approvals.path);
  const home = process.env.MYCLAW_HOME || path.join(os.homedir(), '.myclaw');
  return path.join(home, 'approvals', 'approvals.json');
}

export class ApprovalBroker {
  constructor(options = {}) {
    this.config = options.config || {};
    this.requests = new Map();
    this.transcript = options.transcript || null;
    this.auditLog = options.auditLog || null;
    this.eventBus = options.eventBus || null;
    this.filePath = options.filePath || options.path || defaultApprovalPath(this.config);
    this.persist = options.persist !== false;
    if (this.persist) this._load();
  }

  submit(request, context = {}) {
    const next = new ApprovalRequest({
      ...request,
      sessionId: request.sessionId ?? context.session_id,
      userId: request.userId ?? context.user_id,
      agentId: request.agentId ?? context.agent_id,
    });
    this.requests.set(next.id, next);
    this._save();
    this._audit('approval.submitted', next, context);
    return next;
  }

  approve(id, approverContext = {}, reason = '') {
    return this.resolve(id, APPROVAL_STATUS.APPROVED, approverContext, reason);
  }

  deny(id, approverContext = {}, reason = '') {
    return this.resolve(id, APPROVAL_STATUS.DENIED, approverContext, reason);
  }

  get(id) {
    return this.requests.get(id) || null;
  }

  list(filters = {}) {
    return [...this.requests.values()]
      .filter(request => matchesFilters(request, filters))
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  }

  listPending(filters = {}) {
    return this.list({ ...filters, status: APPROVAL_STATUS.PENDING });
  }

  expireOld(now = new Date()) {
    const nowMs = new Date(now).getTime();
    const expired = [];
    for (const request of this.requests.values()) {
      if (request.status !== APPROVAL_STATUS.PENDING) continue;
      if (request.expiresAt && new Date(request.expiresAt).getTime() <= nowMs) {
        request.status = APPROVAL_STATUS.EXPIRED;
        request.decision = APPROVAL_STATUS.EXPIRED;
        request.decidedAt = new Date(nowMs).toISOString();
        this._audit('approval.expired', request, {});
        expired.push(request);
      }
    }
    if (expired.length > 0) this._save();
    return expired;
  }

  resolve(id, decision, context = {}, reason = '') {
    const request = this.get(id);
    if (!request) throw new Error(`Approval request not found: ${id}`);
    if (![APPROVAL_STATUS.APPROVED, APPROVAL_STATUS.DENIED].includes(decision)) {
      throw new Error(`Invalid approval decision: ${decision}`);
    }

    this._enforceDecisionPermission(request, context);
    if (request.status === APPROVAL_STATUS.PENDING && new Date(request.expiresAt).getTime() <= Date.now()) {
      request.status = APPROVAL_STATUS.EXPIRED;
      request.decision = APPROVAL_STATUS.EXPIRED;
      request.decidedAt = new Date().toISOString();
      this._save();
      this._audit('approval.expired', request, context);
      return request;
    }
    if (request.status !== APPROVAL_STATUS.PENDING) {
      return request;
    }

    request.status = decision;
    request.decision = reason || decision;
    request.decidedBy = context.decidedBy || context.user_id || context.userId || context.agent_id || context.agentId || 'unknown';
    request.decidedAt = new Date().toISOString();
    this._save();
    this._audit(decision === APPROVAL_STATUS.APPROVED ? 'approval.approved' : 'approval.denied', request, context);
    return request;
  }

  _enforceDecisionPermission(request, context = {}) {
    const granted = new Set(context.permissions || []);
    const required = requiredPermissionsFor(request.type);
    if (required.some(permission => granted.has(permission))) return;
    throw new ApprovalPermissionError(`Approving ${request.type} requires one of: ${required.join(', ')}`, {
      type: request.type,
      required,
    });
  }

  _audit(eventName, request, context = {}) {
    this.transcript?.recordSystemEvent?.({
      session: null,
      eventId: `${request.id}:${eventName}`,
      content: {
        event: eventName,
        approvalId: request.id,
        status: request.status,
        type: request.type,
        toolName: request.toolName,
        reason: request.reason,
        decision: request.decision,
      },
      context: {
        session_id: request.sessionId || context.session_id || null,
        user_id: request.userId || context.user_id || null,
        agent_id: request.agentId || context.agent_id || null,
        lane_id: context.lane_id || null,
      },
      metadata: {
        approval_event: eventName,
        approval_id: request.id,
        approval_status: request.status,
        approval_type: request.type,
        tool_name: request.toolName,
      },
    });
    this.auditLog?.write?.({
      eventType: eventName,
      subject: request.subject,
      subjectRole: 'approval',
      sessionId: request.sessionId || context.session_id || null,
      userId: request.userId || context.user_id || null,
      agentId: request.agentId || context.agent_id || null,
      action: request.action,
      resource: request.resource,
      toolName: request.toolName,
      decision: decisionForApprovalEvent(eventName),
      reason: request.reason,
      riskLevel: request.riskLevel,
      approvalId: request.id,
      metadata: {
        status: request.status,
        type: request.type,
        decision: request.decision,
        decidedBy: request.decidedBy,
      },
      source: 'approval-broker',
    });
    this.eventBus?.publish?.({
      type: eventName,
      source: 'approval-broker',
      sessionId: request.sessionId || context.session_id || null,
      userId: request.userId || context.user_id || null,
      agentId: request.agentId || context.agent_id || null,
      approvalId: request.id,
      toolName: request.toolName,
      decision: decisionForApprovalEvent(eventName),
      riskLevel: request.riskLevel,
      summary: request.reason || eventName,
      metadata: {
        status: request.status,
        approvalType: request.type,
        subject: request.subject,
        action: request.action,
        resource: request.resource,
        decidedBy: request.decidedBy,
      },
    });
  }

  _load() {
    const data = readJsonSafe(this.filePath, { schemaVersion: 1, requests: [] });
    const requests = Array.isArray(data) ? data : data.requests || [];
    for (const request of requests) {
      const next = new ApprovalRequest(request);
      this.requests.set(next.id, next);
    }
  }

  _save() {
    if (!this.persist) return;
    const data = {
      schemaVersion: 1,
      updatedAt: new Date().toISOString(),
      requests: [...this.requests.values()].map(request => request.toJSON()),
    };
    atomicWriteJson(this.filePath, data, storageOptions(this));
  }
}

function decisionForApprovalEvent(eventName) {
  if (eventName === 'approval.submitted') return 'ask';
  if (eventName === 'approval.approved') return 'approved';
  if (eventName === 'approval.denied') return 'rejected';
  if (eventName === 'approval.expired') return 'rejected';
  return 'error';
}

export function requiredPermissionsFor(type) {
  if (type === APPROVAL_TYPES.TOOL_CALL) {
    return [APPROVAL_PERMISSIONS.TOOL_CALL, APPROVAL_PERMISSIONS.POLICY_CHANGE, APPROVAL_PERMISSIONS.ADMIN];
  }
  if (type === APPROVAL_TYPES.MEMORY_WRITE) {
    return [
      APPROVAL_PERMISSIONS.MEMORY_WRITE,
      APPROVAL_PERMISSIONS.MEMORY_WRITE_STRONG,
      APPROVAL_PERMISSIONS.POLICY_CHANGE,
      APPROVAL_PERMISSIONS.ADMIN,
    ];
  }
  if (type === APPROVAL_TYPES.POLICY_CHANGE) {
    return [APPROVAL_PERMISSIONS.POLICY_CHANGE, APPROVAL_PERMISSIONS.ADMIN];
  }
  return [APPROVAL_PERMISSIONS.SYSTEM_ACTION, APPROVAL_PERMISSIONS.POLICY_CHANGE, APPROVAL_PERMISSIONS.ADMIN];
}

function matchesFilters(request, filters = {}) {
  for (const [key, expected] of Object.entries(filters)) {
    if (expected === undefined || expected === null) continue;
    const actual = request[key] ?? request[toCamel(key)] ?? null;
    if (actual !== expected) return false;
  }
  return true;
}

function toCamel(value) {
  return value.replace(/_([a-z])/g, (_, char) => char.toUpperCase());
}

function expandHome(value) {
  if (!value || !value.startsWith('~')) return value;
  if (value === '~') return os.homedir();
  if (value.startsWith('~/') || value.startsWith(`~${path.sep}`)) {
    return path.join(os.homedir(), value.slice(2));
  }
  return value;
}

function storageOptions(broker) {
  return {
    enabled: broker.config?.storage?.atomicWrites?.enabled !== false,
  };
}
