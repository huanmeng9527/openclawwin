import { APPROVAL_PERMISSIONS } from '../../approval/index.js';
import { AuditLog } from '../../audit/index.js';
import { Config } from '../../config/index.js';
import { MEMORY_PERMISSIONS, MemoryProposalStore, MemoryRouter } from '../../memory/index.js';
import { redactSecretText } from '../../memory/sanitizer.js';

export function memoryProposalsListCommand(options = {}) {
  const store = createMemoryProposalStoreForCli();
  const proposals = store.listProposals(options.all ? {} : { status: options.status || 'pending' });
  if (!proposals.length) {
    console.log('No memory proposals found.');
    return;
  }
  for (const proposal of proposals) {
    console.log(formatProposalRow(proposal));
  }
}

export function memoryProposalsShowCommand(id) {
  const proposal = createMemoryProposalStoreForCli().getProposal(id);
  if (!proposal) throw new Error(`Memory proposal not found: ${id}`);
  console.log(JSON.stringify(sanitizeProposalForDisplay(proposal), null, 2));
}

export function memoryProposalsApproveCommand(id, options = {}) {
  const proposal = createMemoryProposalStoreForCli().approveProposal(id, proposalCliContext(), options.reason || 'approved by CLI');
  console.log(`approved ${proposal.id} status=${proposal.status}`);
}

export function memoryProposalsRejectCommand(id, options = {}) {
  const proposal = createMemoryProposalStoreForCli().rejectProposal(id, proposalCliContext(), options.reason || 'rejected by CLI');
  console.log(`rejected ${proposal.id} status=${proposal.status}`);
}

export function memoryProposalsWriteCommand(id) {
  const proposal = createMemoryProposalStoreForCli().writeApprovedProposal(id, proposalCliContext());
  console.log(`written ${proposal.id} status=${proposal.status} targetMemoryId=${proposal.targetMemoryId || '-'}`);
}

export function createMemoryProposalStoreForCli(overrides = {}) {
  const config = overrides.config || loadConfigData();
  const auditLog = overrides.auditLog || new AuditLog(config);
  const memoryRouter = overrides.memoryRouter || new MemoryRouter(config, { auditLog });
  return new MemoryProposalStore({ config, auditLog, memoryRouter, ...overrides });
}

function proposalCliContext() {
  return {
    user_id: 'cli',
    agent_id: 'myclaw',
    permissions: [
      APPROVAL_PERMISSIONS.ADMIN,
      APPROVAL_PERMISSIONS.MEMORY_WRITE,
      MEMORY_PERMISSIONS.WRITE,
    ],
    decidedBy: 'cli',
  };
}

function loadConfigData() {
  if (!Config.exists()) return {};
  const config = new Config();
  return config.load().all();
}

function formatProposalRow(proposal) {
  return [
    proposal.id,
    proposal.type,
    proposal.status,
    proposal.confidence,
    proposal.targetHint,
    safeText(proposal.title),
    proposal.createdAt,
  ].join('\t');
}

function sanitizeProposalForDisplay(proposal) {
  const data = proposal.toJSON ? proposal.toJSON() : { ...proposal };
  return {
    ...data,
    title: safeText(data.title),
    content: safeText(data.content),
    reason: safeText(data.reason),
  };
}

function safeText(value) {
  return redactSecretText(String(value || ''));
}
