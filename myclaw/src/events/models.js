import crypto from 'node:crypto';
import { redactSecretText, sanitizeValue, truncate } from '../memory/sanitizer.js';

export class RuntimeEvent {
  constructor(data = {}) {
    this.id = data.id || createEventId();
    this.timestamp = data.timestamp || new Date().toISOString();
    this.type = safeText(data.type || data.eventType || 'event', 120);
    this.source = safeText(data.source || 'myclaw', 120);
    this.sessionId = data.sessionId || data.session_id || null;
    this.userId = data.userId || data.user_id || null;
    this.agentId = data.agentId || data.agent_id || null;
    this.approvalId = data.approvalId || data.approval_id || null;
    this.proposalId = data.proposalId || data.proposal_id || null;
    this.toolName = data.toolName || data.tool_name || null;
    this.decision = data.decision || null;
    this.riskLevel = data.riskLevel || data.risk_level || 'low';
    this.summary = safeText(data.summary || data.reason || '', 500);
    this.metadata = sanitizeEventMetadata(data.metadata || {});
  }

  toJSON() {
    return { ...this };
  }
}

export function createEventId() {
  return `evt_${crypto.randomBytes(8).toString('hex')}`;
}

export function sanitizeEventMetadata(metadata = {}, options = {}) {
  return redactStrings(sanitizeValue(metadata, { maxChars: options.maxChars || 1000 }));
}

function redactStrings(value) {
  if (typeof value === 'string') return redactSecretText(truncate(value, 1000));
  if (!value || typeof value !== 'object') return value;
  if (Array.isArray(value)) return value.map(redactStrings);
  const out = {};
  for (const [key, child] of Object.entries(value)) {
    out[key] = redactStrings(child);
  }
  return out;
}

function safeText(value, maxChars) {
  return truncate(redactSecretText(String(value || '')), maxChars);
}
