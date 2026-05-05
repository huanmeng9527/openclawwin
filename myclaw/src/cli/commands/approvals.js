import { ApprovalBroker, APPROVAL_PERMISSIONS, APPROVAL_STATUS } from '../../approval/index.js';
import { AuditLog } from '../../audit/index.js';
import { Config } from '../../config/index.js';
import { MemoryRouter } from '../../memory/index.js';
import { SessionTranscriptRecorder } from '../../session/transcript.js';
import { redactSecretText } from '../../memory/sanitizer.js';

export function approvalsListCommand(options = {}) {
  const broker = createApprovalBrokerForCli();
  const status = options.status || (options.all ? null : APPROVAL_STATUS.PENDING);
  const requests = broker.list(status ? { status } : {});

  if (requests.length === 0) {
    console.log('No approval requests found.');
    return;
  }

  for (const request of requests) {
    console.log(formatApprovalRow(request));
  }
}

export function approvalsShowCommand(id) {
  const broker = createApprovalBrokerForCli();
  const request = broker.get(id);
  if (!request) {
    throw new Error(`Approval request not found: ${id}`);
  }
  console.log(JSON.stringify(sanitizeApprovalForDisplay(request), null, 2));
}

export function approvalsApproveCommand(id, options = {}) {
  const broker = createApprovalBrokerForCli();
  const request = broker.get(id);
  if (!request) throw new Error(`Approval request not found: ${id}`);

  const approved = broker.approve(id, approvalCliContext(request), options.reason || 'approved by CLI');
  console.log(`approved ${approved.id} status=${approved.status}`);
}

export function approvalsDenyCommand(id, options = {}) {
  const broker = createApprovalBrokerForCli();
  const request = broker.get(id);
  if (!request) throw new Error(`Approval request not found: ${id}`);

  const denied = broker.deny(id, approvalCliContext(request), options.reason || 'denied by CLI');
  console.log(`denied ${denied.id} status=${denied.status}`);
}

export function createApprovalBrokerForCli(overrides = {}) {
  const config = overrides.config || loadConfigData();
  const auditLog = overrides.auditLog || new AuditLog(config);
  const memoryRouter = overrides.memoryRouter || new MemoryRouter(config, { auditLog });
  const transcript = overrides.transcript || new SessionTranscriptRecorder(memoryRouter);
  return new ApprovalBroker({ config, auditLog, transcript, ...overrides });
}

export function approvalCliContext(request) {
  return {
    session_id: request.sessionId || null,
    user_id: request.userId || 'cli',
    agent_id: request.agentId || 'myclaw',
    permissions: [APPROVAL_PERMISSIONS.ADMIN],
    decidedBy: 'cli',
  };
}

function loadConfigData() {
  if (!Config.exists()) return {};
  const config = new Config();
  return config.load().all();
}

function formatApprovalRow(request) {
  return [
    request.id,
    request.type,
    request.toolName || '-',
    request.riskLevel || '-',
    request.status,
    safeText(request.reason || '-'),
    request.createdAt,
  ].join('\t');
}

function sanitizeApprovalForDisplay(request) {
  const data = request.toJSON ? request.toJSON() : { ...request };
  return {
    ...data,
    payloadSummary: safeText(data.payloadSummary || ''),
    reason: safeText(data.reason || ''),
    resource: safeText(data.resource || ''),
  };
}

function safeText(value) {
  return redactSecretText(String(value || ''));
}
