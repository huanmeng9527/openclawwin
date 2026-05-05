import crypto from 'node:crypto';
import { sanitizeValue, truncate } from '../memory/sanitizer.js';

export class AuditEvent {
  constructor(data = {}) {
    this.id = data.id || createAuditId();
    this.timestamp = data.timestamp || new Date().toISOString();
    this.eventType = data.eventType || data.event_type || 'event';
    this.subject = data.subject || '';
    this.subjectRole = data.subjectRole || data.subject_role || '';
    this.sessionId = data.sessionId || data.session_id || null;
    this.userId = data.userId || data.user_id || null;
    this.agentId = data.agentId || data.agent_id || null;
    this.action = data.action || '';
    this.resource = data.resource || '';
    this.toolName = data.toolName || data.tool_name || null;
    this.permission = data.permission || null;
    this.decision = data.decision || null;
    this.reason = data.reason || '';
    this.riskLevel = data.riskLevel || data.risk_level || 'low';
    this.approvalId = data.approvalId || data.approval_id || null;
    this.metadata = sanitizeAuditMetadata(data.metadata || {});
    this.source = data.source || 'myclaw';
  }

  toJSON() {
    return { ...this };
  }
}

export function createAuditId() {
  return `audit_${crypto.randomBytes(8).toString('hex')}`;
}

export function sanitizeAuditMetadata(metadata = {}, options = {}) {
  const maxChars = options.maxChars || 1000;
  const sanitized = sanitizeValue(metadata, { maxChars });
  if (typeof sanitized === 'string') return truncate(sanitized, maxChars);
  return sanitized;
}
