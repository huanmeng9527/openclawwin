import os from 'node:os';
import path from 'node:path';
import { APPROVAL_PERMISSIONS, APPROVAL_TYPES } from '../approval/index.js';
import { MemoryRecord, createId } from './models.js';
import { MEMORY_PERMISSIONS, MemoryPolicyError } from './policy.js';
import { redactSecretText, truncate } from './sanitizer.js';
import { atomicWriteJson, readJsonSafe } from '../storage/index.js';

export const MEMORY_PROPOSAL_STATUS = {
  PENDING: 'pending',
  APPROVED: 'approved',
  REJECTED: 'rejected',
  WRITTEN: 'written',
};

export const MEMORY_PROPOSAL_TYPES = {
  SEMANTIC_FACT: 'semantic_fact',
  PREFERENCE: 'preference',
  PROJECT_NOTE: 'project_note',
  DECISION: 'decision',
};

const DEFAULT_PROPOSALS = {
  enabled: true,
  autoCreateFromCompaction: false,
  minConfidence: 0.7,
  maxCandidatesPerSummary: 5,
};

export function defaultProposalPath(config = {}) {
  if (config.memory?.proposals?.path) return expandHome(config.memory.proposals.path);
  const home = process.env.MYCLAW_HOME || path.join(os.homedir(), '.myclaw');
  return path.join(home, 'memory', 'proposals', 'proposals.json');
}

export class MemoryProposal {
  constructor(data = {}) {
    const now = new Date().toISOString();
    this.id = data.id || createId('proposal');
    this.type = data.type || MEMORY_PROPOSAL_TYPES.SEMANTIC_FACT;
    this.status = data.status || MEMORY_PROPOSAL_STATUS.PENDING;
    this.content = safeText(data.content || '', 1000);
    this.title = safeText(data.title || titleFromContent(this.type, this.content), 180);
    this.tags = Array.from(new Set(data.tags || ['proposal', this.type]));
    this.namespace = data.namespace || 'default';
    this.confidence = data.confidence ?? 0.7;
    this.reason = safeText(data.reason || '', 500);
    this.sourceSessionId = data.sourceSessionId || data.source_session_id || null;
    this.sourceSummaryId = data.sourceSummaryId || data.source_summary_id || null;
    this.sourceEventIds = data.sourceEventIds || data.source_event_ids || [];
    this.createdAt = data.createdAt || data.created_at || now;
    this.updatedAt = data.updatedAt || data.updated_at || now;
    this.decidedAt = data.decidedAt || data.decided_at || null;
    this.decidedBy = data.decidedBy || data.decided_by || null;
    this.approvalId = data.approvalId || data.approval_id || null;
    this.targetLayer = data.targetLayer || data.target_layer || 'semantic';
    this.targetHint = data.targetHint || data.target_hint || targetHintFor(this.type);
    this.targetMemoryId = data.targetMemoryId || data.target_memory_id || null;
    this.metadata = data.metadata || {};
  }

  toMemoryRecord() {
    return new MemoryRecord({
      id: `semantic_from_${this.id}`,
      layer: 'semantic',
      namespace: this.namespace,
      scope: this.namespace,
      key: this.id,
      title: this.title,
      content: this.content,
      tags: this.tags,
      metadata: {
        ...this.metadata,
        category: this.targetHint,
        proposalId: this.id,
        proposalType: this.type,
        sourceSessionId: this.sourceSessionId,
        sourceSummaryId: this.sourceSummaryId,
        sourceEventIds: this.sourceEventIds,
      },
      source: this.sourceSummaryId
        ? `proposal:${this.id}; summary:${this.sourceSummaryId}`
        : `proposal:${this.id}`,
      confidence: this.confidence,
      visibility: 'private',
      risk_level: 'low',
    });
  }

  toJSON() {
    return { ...this };
  }
}

export class MemoryProposalStore {
  constructor(options = {}) {
    this.config = options.config || {};
    this.filePath = options.filePath || defaultProposalPath(this.config);
    this.memoryRouter = options.memoryRouter || null;
    this.auditLog = options.auditLog || null;
    this.approvalBroker = options.approvalBroker || null;
    this.eventBus = options.eventBus || null;
    this.proposals = new Map();
    this._load();
  }

  createProposal(candidate, context = {}) {
    const settings = proposalSettings(this.config);
    if (settings.enabled === false) return null;
    if ((candidate.confidence ?? 0) < settings.minConfidence) return null;

    const existing = this._findDuplicate(candidate);
    if (existing) return existing;

    const proposal = new MemoryProposal(candidate);
    if (this.approvalBroker) {
      const approval = this.approvalBroker.submit({
        type: APPROVAL_TYPES.MEMORY_WRITE,
        subject: proposal.title,
        action: 'write_semantic_memory',
        resource: proposal.targetHint,
        riskLevel: 'medium',
        reason: proposal.reason || 'Semantic memory proposal requires review',
        payload: {
          proposalId: proposal.id,
          content: proposal.content,
          targetHint: proposal.targetHint,
        },
        sessionId: proposal.sourceSessionId || context.session_id,
        userId: context.user_id,
        agentId: context.agent_id,
      }, context);
      proposal.approvalId = approval.id;
    }

    this.proposals.set(proposal.id, proposal);
    this._save();
    this._audit('memory.proposal.created', proposal, context, {
      decision: 'ask',
      reason: proposal.reason,
    });
    return proposal;
  }

  listProposals(filters = {}) {
    return [...this.proposals.values()]
      .filter(proposal => matchesProposal(proposal, filters))
      .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
  }

  getProposal(id) {
    return this.proposals.get(id) || null;
  }

  approveProposal(id, context = {}, reason = '') {
    const proposal = this._requireProposal(id);
    this._requireDecisionPermission(context);
    if (proposal.status === MEMORY_PROPOSAL_STATUS.REJECTED) {
      throw new Error(`Cannot approve rejected proposal: ${id}`);
    }
    if (proposal.status === MEMORY_PROPOSAL_STATUS.WRITTEN) return proposal;

    proposal.status = MEMORY_PROPOSAL_STATUS.APPROVED;
    proposal.decidedAt = new Date().toISOString();
    proposal.decidedBy = context.decidedBy || context.user_id || context.userId || 'unknown';
    proposal.reason = safeText(reason || proposal.reason, 500);
    proposal.updatedAt = proposal.decidedAt;
    this._save();
    this._audit('memory.proposal.approved', proposal, context, {
      decision: 'approved',
      reason: proposal.reason,
    });
    return proposal;
  }

  rejectProposal(id, context = {}, reason = '') {
    const proposal = this._requireProposal(id);
    this._requireDecisionPermission(context);
    if (proposal.status === MEMORY_PROPOSAL_STATUS.WRITTEN) {
      throw new Error(`Cannot reject written proposal: ${id}`);
    }
    proposal.status = MEMORY_PROPOSAL_STATUS.REJECTED;
    proposal.decidedAt = new Date().toISOString();
    proposal.decidedBy = context.decidedBy || context.user_id || context.userId || 'unknown';
    proposal.reason = safeText(reason || proposal.reason, 500);
    proposal.updatedAt = proposal.decidedAt;
    this._save();
    this._audit('memory.proposal.rejected', proposal, context, {
      decision: 'rejected',
      reason: proposal.reason,
    });
    return proposal;
  }

  writeApprovedProposal(id, context = {}) {
    const proposal = this._requireProposal(id);
    if (proposal.status === MEMORY_PROPOSAL_STATUS.WRITTEN) return proposal;
    if (proposal.status === MEMORY_PROPOSAL_STATUS.REJECTED) {
      const error = new Error(`Cannot write rejected proposal: ${id}`);
      this._audit('memory.proposal.write_denied', proposal, context, {
        decision: 'deny',
        reason: error.message,
      });
      throw error;
    }
    if (proposal.status !== MEMORY_PROPOSAL_STATUS.APPROVED) {
      const error = new Error(`Proposal must be approved before writing: ${id}`);
      this._audit('memory.proposal.write_denied', proposal, context, {
        decision: 'deny',
        reason: error.message,
      });
      throw error;
    }
    if (!this.memoryRouter) throw new Error('MemoryProposalStore requires memoryRouter to write proposals');

    try {
      const saved = this.memoryRouter.write(proposal.toMemoryRecord(), 'semantic', context);
      proposal.status = MEMORY_PROPOSAL_STATUS.WRITTEN;
      proposal.targetMemoryId = saved.id;
      proposal.updatedAt = new Date().toISOString();
      this._save();
      this._audit('memory.proposal.written', proposal, context, {
        decision: 'allow',
        reason: 'approved proposal written to L3 semantic memory',
        metadata: { targetMemoryId: saved.id },
      });
      return proposal;
    } catch (err) {
      this._audit('memory.proposal.write_denied', proposal, context, {
        decision: 'deny',
        reason: err.message,
      });
      throw err;
    }
  }

  _requireProposal(id) {
    const proposal = this.getProposal(id);
    if (!proposal) throw new Error(`Memory proposal not found: ${id}`);
    return proposal;
  }

  _requireDecisionPermission(context = {}) {
    const granted = new Set(context.permissions || []);
    const required = [
      APPROVAL_PERMISSIONS.MEMORY_WRITE,
      MEMORY_PERMISSIONS.WRITE,
      MEMORY_PERMISSIONS.POLICY_CHANGE,
      APPROVAL_PERMISSIONS.ADMIN,
    ];
    if (required.some(permission => granted.has(permission))) return;
    throw new MemoryPolicyError(`Memory proposal decision requires one of: ${required.join(', ')}`, {
      permissions: required,
    });
  }

  _findDuplicate(candidate) {
    const signature = proposalSignature(candidate);
    return [...this.proposals.values()].find(proposal => proposalSignature(proposal) === signature) || null;
  }

  _audit(eventType, proposal, context = {}, details = {}) {
    this.auditLog?.write?.({
      eventType,
      subject: proposal.id,
      subjectRole: 'memory_proposal',
      sessionId: proposal.sourceSessionId || context.session_id || null,
      userId: context.user_id || null,
      agentId: context.agent_id || null,
      action: eventType,
      resource: proposal.targetHint,
      permission: MEMORY_PERMISSIONS.WRITE,
      decision: details.decision || null,
      reason: details.reason || proposal.reason || '',
      riskLevel: 'low',
      approvalId: proposal.approvalId || null,
      metadata: {
        proposalType: proposal.type,
        proposalStatus: proposal.status,
        confidence: proposal.confidence,
        sourceSummaryId: proposal.sourceSummaryId,
        contentSummary: truncate(proposal.content, 300),
        ...(details.metadata || {}),
      },
      source: 'memory-proposal-store',
    });
    if (eventType !== 'memory.proposal.write_denied') {
      this.eventBus?.publish?.({
        type: eventType,
        source: 'memory-proposal-store',
        sessionId: proposal.sourceSessionId || context.session_id || null,
        userId: context.user_id || null,
        agentId: context.agent_id || null,
        approvalId: proposal.approvalId || null,
        proposalId: proposal.id,
        decision: details.decision || null,
        riskLevel: 'low',
        summary: details.reason || proposal.reason || eventType,
        metadata: {
          proposalType: proposal.type,
          proposalStatus: proposal.status,
          confidence: proposal.confidence,
          sourceSummaryId: proposal.sourceSummaryId,
          targetHint: proposal.targetHint,
          ...(details.metadata || {}),
        },
      });
    }
  }

  _load() {
    const raw = readJsonSafe(this.filePath, { schemaVersion: 1, proposals: [] });
    const proposals = Array.isArray(raw) ? raw : raw.proposals || [];
    for (const proposal of proposals) {
      const next = new MemoryProposal(proposal);
      this.proposals.set(next.id, next);
    }
  }

  _save() {
    atomicWriteJson(this.filePath, {
      schemaVersion: 1,
      updatedAt: new Date().toISOString(),
      proposals: [...this.proposals.values()].map(proposal => proposal.toJSON()),
    }, {
      enabled: this.config.storage?.atomicWrites?.enabled !== false,
    });
  }
}

export function proposalSettings(config = {}) {
  return {
    ...DEFAULT_PROPOSALS,
    ...(config.memory?.proposals || {}),
  };
}

function matchesProposal(proposal, filters = {}) {
  for (const [key, expected] of Object.entries(filters || {})) {
    if (expected === undefined || expected === null || expected === '') continue;
    const actual = proposal[key] ?? proposal[toCamel(key)] ?? null;
    if (actual !== expected) return false;
  }
  return true;
}

function proposalSignature(candidate) {
  return [
    candidate.type || MEMORY_PROPOSAL_TYPES.SEMANTIC_FACT,
    candidate.namespace || 'default',
    candidate.sourceSummaryId || '',
    safeText(candidate.content || '', 1000).toLowerCase(),
  ].join('|');
}

function safeText(value, maxChars) {
  return truncate(redactSecretText(String(value || '').replace(/\s+/g, ' ').trim()), maxChars);
}

function titleFromContent(type, content) {
  return `${type}: ${String(content || '').slice(0, 80)}`;
}

function targetHintFor(type) {
  if (type === MEMORY_PROPOSAL_TYPES.PREFERENCE) return 'preferences';
  if (type === MEMORY_PROPOSAL_TYPES.PROJECT_NOTE) return 'project_notes';
  if (type === MEMORY_PROPOSAL_TYPES.DECISION) return 'decisions';
  return 'facts';
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
