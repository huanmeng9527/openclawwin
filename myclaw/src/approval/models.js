import crypto from 'node:crypto';
import { redactSecretText, summarizeForStorage, truncate } from '../memory/sanitizer.js';

export const APPROVAL_TYPES = {
  TOOL_CALL: 'tool_call',
  MEMORY_WRITE: 'memory_write',
  POLICY_CHANGE: 'policy_change',
  SYSTEM_ACTION: 'system_action',
};

export const APPROVAL_STATUS = {
  PENDING: 'pending',
  APPROVED: 'approved',
  DENIED: 'denied',
  EXPIRED: 'expired',
};

export const APPROVAL_PERMISSIONS = {
  TOOL_CALL: 'approval.tool.call',
  MEMORY_WRITE: 'approval.memory.write',
  SYSTEM_ACTION: 'approval.system.action',
  ADMIN: 'approval.admin',
  POLICY_CHANGE: 'policy.change',
  MEMORY_WRITE_STRONG: 'memory.write',
};

export class ApprovalRequest {
  constructor(data = {}) {
    const now = new Date();
    this.id = data.id || createApprovalId();
    this.type = data.type || APPROVAL_TYPES.TOOL_CALL;
    this.subject = data.subject || data.toolName || '';
    this.action = data.action || '';
    this.resource = data.resource || '';
    this.riskLevel = data.riskLevel || 'medium';
    this.reason = data.reason || '';
    this.payloadSummary = sanitizeApprovalPayloadSummary(data.payloadSummary ?? data.payload ?? {}, 1000);
    this.sessionId = data.sessionId || data.session_id || null;
    this.userId = data.userId || data.user_id || null;
    this.agentId = data.agentId || data.agent_id || null;
    this.toolName = data.toolName || data.tool_name || null;
    this.createdAt = data.createdAt || now.toISOString();
    this.expiresAt = data.expiresAt || new Date(now.getTime() + (data.ttlMs || 5 * 60 * 1000)).toISOString();
    this.status = data.status || APPROVAL_STATUS.PENDING;
    this.decision = data.decision || null;
    this.decidedBy = data.decidedBy || null;
    this.decidedAt = data.decidedAt || null;
  }

  toJSON() {
    return { ...this };
  }
}

export class ApprovalPermissionError extends Error {
  constructor(message, details = {}) {
    super(message);
    this.name = 'ApprovalPermissionError';
    this.details = details;
  }
}

export function createApprovalId() {
  return `appr_${crypto.randomBytes(8).toString('hex')}`;
}

export function sanitizeApprovalPayloadSummary(value, maxChars = 1000) {
  if (typeof value === 'string') return truncate(redactSecretText(value), maxChars);
  return summarizeForStorage(value, { maxChars });
}
