import { AuditLog } from '../../audit/index.js';
import { Config } from '../../config/index.js';
import { redactSecretText } from '../../memory/sanitizer.js';

export function auditTailCommand(options = {}) {
  const lines = parseLimit(options.lines, 20);
  const auditLog = new AuditLog(loadConfigData());
  printAuditEvents(auditLog.query({ limit: lines }));
}

export function auditQueryCommand(options = {}) {
  const auditLog = new AuditLog(loadConfigData());
  const filters = {
    eventType: options.eventType,
    decision: options.decision,
    toolName: options.tool,
    sessionId: options.session,
    userId: options.user,
    agentId: options.agent,
    approvalId: options.approval,
    since: options.since,
    until: options.until,
    limit: parseLimit(options.limit, 100),
  };
  printAuditEvents(auditLog.query(filters));
}

export function printAuditEvents(events) {
  if (!events.length) {
    console.log('No audit events found.');
    return;
  }
  for (const event of events) {
    console.log(formatAuditRow(event));
  }
}

function loadConfigData() {
  if (!Config.exists()) return {};
  const config = new Config();
  return config.load().all();
}

function parseLimit(value, fallback) {
  const parsed = Number.parseInt(value, 10);
  if (!Number.isFinite(parsed) || parsed <= 0) return fallback;
  return parsed;
}

function formatAuditRow(event) {
  return [
    event.timestamp,
    event.eventType,
    event.decision || '-',
    event.toolName || '-',
    safeText(event.action || '-'),
    safeText(event.resource || '-'),
    safeText(event.reason || '-'),
    event.approvalId || '-',
  ].join('\t');
}

function safeText(value) {
  return redactSecretText(String(value || ''));
}
