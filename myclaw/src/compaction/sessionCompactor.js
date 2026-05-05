import { MemoryRecord, createId } from '../memory/models.js';
import { MemoryProposalStore, proposalSettings } from '../memory/proposals.js';
import { StableFactExtractor } from '../memory/stableFactExtractor.js';
import { summarizeForStorage, truncate } from '../memory/sanitizer.js';

export const SUMMARY_TYPE = 'l2_session_summary';

export const DEFAULT_SESSION_COMPACTION = {
  enabled: true,
  maxEventsBeforeCompact: 30,
  maxCharsBeforeCompact: 20000,
  maxSummaryChars: 4000,
  keepRecentEvents: 8,
};

export class SummaryRecord {
  constructor(data = {}) {
    const now = new Date().toISOString();
    this.id = data.id || `session_summary:${data.sessionId || data.session_id || createId('session')}`;
    this.sessionId = data.sessionId || data.session_id || null;
    this.agentId = data.agentId || data.agent_id || null;
    this.userId = data.userId || data.user_id || null;
    this.summaryType = data.summaryType || SUMMARY_TYPE;
    this.sourceEventIds = data.sourceEventIds || data.source_event_ids || [];
    this.content = data.content || '';
    this.createdAt = data.createdAt || data.created_at || now;
    this.updatedAt = data.updatedAt || data.updated_at || now;
    this.charCount = data.charCount ?? data.char_count ?? this.content.length;
    this.tokenApprox = data.tokenApprox ?? data.token_approx ?? Math.ceil(this.charCount / 4);
    this.eventCount = data.eventCount ?? data.event_count ?? this.sourceEventIds.length;
    this.metadata = data.metadata || {};
  }

  toMemoryRecord(context = {}) {
    return new MemoryRecord({
      id: this.id,
      layer: 'session',
      namespace: 'session',
      scope: this.sessionId || context.session_id || 'global',
      session_id: this.sessionId || context.session_id || null,
      agent_id: this.agentId || context.agent_id || null,
      user_id: this.userId || context.user_id || null,
      lane_id: context.lane_id || null,
      key: `session_summary:${this.sessionId || context.session_id || 'global'}`,
      title: 'Session summary',
      content: this.content,
      tags: ['session_summary', SUMMARY_TYPE],
      metadata: {
        ...this.metadata,
        summaryType: this.summaryType,
        sourceEventIds: this.sourceEventIds,
        charCount: this.charCount,
        tokenApprox: this.tokenApprox,
        eventCount: this.eventCount,
      },
      source: `session:${this.sessionId || context.session_id || 'global'}:summary`,
      confidence: 1,
      visibility: 'private',
      risk_level: 'low',
    });
  }

  toJSON() {
    return { ...this };
  }
}

export class SessionCompactor {
  constructor(memoryRouter, options = {}) {
    this.memoryRouter = memoryRouter;
    this.transcript = options.transcript || null;
    this.auditLog = options.auditLog || null;
    this.eventBus = options.eventBus || null;
    this.config = options.config || {};
    this.proposalStore = options.proposalStore || null;
    this.factExtractor = options.factExtractor || new StableFactExtractor(this.config);
  }

  shouldCompact(sessionOrEvents, options = {}) {
    const settings = this._settings(options);
    if (!settings.enabled) return false;

    const events = normalizeEvents(sessionOrEvents);
    const compactable = compactableEvents(events);
    if (!compactable.length) return false;

    const latestSummary = latestSummaryRecord(events);
    const keepRecent = Math.max(0, settings.keepRecentEvents);
    const olderEvents = keepRecent > 0 ? compactable.slice(0, Math.max(0, compactable.length - keepRecent)) : compactable;
    if (!olderEvents.length) return false;

    const covered = new Set(latestSummary?.metadata?.sourceEventIds || []);
    const candidates = latestSummary ? olderEvents.filter(event => !covered.has(event.id)) : olderEvents;
    const candidateChars = charCount(candidates);
    const allChars = charCount(compactable);

    if (latestSummary && candidates.length === 0) return false;
    if (latestSummary) {
      return candidates.length > settings.maxEventsBeforeCompact || candidateChars > settings.maxCharsBeforeCompact;
    }
    return compactable.length > settings.maxEventsBeforeCompact || allChars > settings.maxCharsBeforeCompact;
  }

  retrieveSessionEvents(sessionId, context = {}, options = {}) {
    if (!this.memoryRouter?.retrieveSessionEvents) {
      return this.memoryRouter?.session?.list?.({ session_id: sessionId || context.session_id }, options.limit || 100000) || [];
    }
    return this.memoryRouter.retrieveSessionEvents(sessionId || context.session_id, context, { limit: options.limit || 100000 });
  }

  compactSession(sessionId, context = {}, options = {}) {
    const settings = this._settings(options);
    const events = this.retrieveSessionEvents(sessionId, context, { limit: options.limit || 100000 });
    if (!this.shouldCompact(events, settings)) return null;

    const compactable = compactableEvents(events);
    const keepRecent = Math.max(0, settings.keepRecentEvents);
    const sourceEvents = keepRecent > 0 ? compactable.slice(0, Math.max(0, compactable.length - keepRecent)) : compactable;
    const summary = this.summarizeEvents(sourceEvents, {
      ...settings,
      sessionId: sessionId || context.session_id,
      agentId: context.agent_id,
      userId: context.user_id,
    });

    const saved = this.writeSummary(summary, context);
    this._recordCompactionEvent(saved, sourceEvents, context);
    this._maybeCreateMemoryProposals(saved, context, settings);
    return saved;
  }

  summarizeEvents(events, options = {}) {
    const settings = this._settings(options);
    const ordered = normalizeEvents(events).sort(compareAscending);
    const sourceEventIds = ordered.map(event => event.id).filter(Boolean);
    const sessionId = options.sessionId || ordered.find(event => event.session_id)?.session_id || null;
    const agentId = options.agentId || ordered.find(event => event.agent_id)?.agent_id || null;
    const userId = options.userId || ordered.find(event => event.user_id)?.user_id || null;
    const userEvents = ordered.filter(event => event.key === 'user_message');
    const assistantEvents = ordered.filter(event => event.key === 'assistant_message');
    const toolEvents = ordered.filter(event => ['tool_call', 'tool_result', 'tool_error'].includes(event.key));

    const lines = [
      '[Generated deterministic L2 session summary]',
      `Session: ${sessionId || 'unknown'}`,
      `Events summarized: ${ordered.length}`,
    ];

    const latestUser = last(userEvents);
    if (latestUser) lines.push(`Recent user goal: ${preview(latestUser.content, 500)}`);

    if (toolEvents.length) {
      lines.push(`Tool activity: ${toolEvents.length} event(s).`);
      for (const event of toolEvents.slice(-5)) {
        lines.push(`- ${event.key} ${event.title || event.metadata?.tool_name || ''}: ${preview(event.content, 220)}`);
      }
    }

    const latestAssistant = last(assistantEvents);
    if (latestAssistant) lines.push(`Latest assistant answer: ${preview(latestAssistant.content, 600)}`);

    const earlierUserEvents = userEvents.slice(-5);
    if (earlierUserEvents.length) {
      lines.push('Recent user messages:');
      for (const event of earlierUserEvents) {
        lines.push(`- ${preview(event.content, 220)}`);
      }
    }

    const content = truncate(lines.join('\n'), settings.maxSummaryChars);
    return new SummaryRecord({
      id: `session_summary:${sessionId || 'global'}`,
      sessionId,
      agentId,
      userId,
      sourceEventIds,
      content,
      charCount: content.length,
      tokenApprox: Math.ceil(content.length / 4),
      eventCount: ordered.length,
      metadata: {
        generatedBy: 'deterministic-session-compactor',
        keepRecentEvents: settings.keepRecentEvents,
      },
    });
  }

  writeSummary(summary, context = {}) {
    const next = summary instanceof SummaryRecord ? summary : new SummaryRecord(summary);
    return this.memoryRouter.write(next.toMemoryRecord(context), 'session', {
      session_id: next.sessionId || context.session_id,
      agent_id: next.agentId || context.agent_id,
      user_id: next.userId || context.user_id,
      lane_id: context.lane_id,
      permissions: context.permissions || [],
    });
  }

  _settings(options = {}) {
    return {
      ...DEFAULT_SESSION_COMPACTION,
      ...(this.config.memory?.compaction || {}),
      ...options,
    };
  }

  _recordCompactionEvent(summaryRecord, sourceEvents, context = {}) {
    const sessionId = summaryRecord.session_id || context.session_id;
    const metadata = {
      summary_id: summaryRecord.id,
      source_event_count: sourceEvents.length,
      summary_chars: summaryRecord.content.length,
    };

    this.transcript?.recordSystemEvent?.({
      session: null,
      eventId: `session.compacted:${sessionId}:${summaryRecord.updated_at}`,
      content: {
        event: 'session.compacted',
        summaryId: summaryRecord.id,
        sourceEventCount: sourceEvents.length,
      },
      context: {
        session_id: sessionId,
        agent_id: context.agent_id || summaryRecord.agent_id,
        user_id: context.user_id || summaryRecord.user_id,
        lane_id: context.lane_id || null,
      },
      metadata: {
        compaction_event: 'session.compacted',
        ...metadata,
      },
    });

    this.auditLog?.write?.({
      eventType: 'session.compaction.run',
      subject: sessionId || '',
      subjectRole: 'session',
      sessionId,
      userId: context.user_id || summaryRecord.user_id || null,
      agentId: context.agent_id || summaryRecord.agent_id || null,
      action: 'compact',
      resource: `session:${sessionId || 'global'}`,
      decision: 'allow',
      reason: 'L2 session summary generated',
      riskLevel: 'low',
      metadata,
      source: 'session-compactor',
    });
    this.eventBus?.publish?.({
      type: 'session.compacted',
      source: 'session-compactor',
      sessionId,
      userId: context.user_id || summaryRecord.user_id || null,
      agentId: context.agent_id || summaryRecord.agent_id || null,
      decision: 'allow',
      riskLevel: 'low',
      summary: 'L2 session summary generated',
      metadata,
    });
  }

  _maybeCreateMemoryProposals(summaryRecord, context = {}, _settings = {}) {
    const settings = proposalSettings(this.config);
    if (!settings.enabled || !settings.autoCreateFromCompaction) return [];
    const store = this.proposalStore || new MemoryProposalStore({
      config: this.config,
      memoryRouter: this.memoryRouter,
      auditLog: this.auditLog,
    });
    const candidates = this.factExtractor.extractCandidatesFromSummary(summaryRecord, context, {
      minConfidence: settings.minConfidence,
      maxCandidates: settings.maxCandidatesPerSummary,
    });
    return candidates
      .map(candidate => store.createProposal(candidate, context))
      .filter(Boolean);
  }
}

function normalizeEvents(sessionOrEvents) {
  if (!sessionOrEvents) return [];
  if (Array.isArray(sessionOrEvents)) return sessionOrEvents;
  if (Array.isArray(sessionOrEvents.messages)) {
    return sessionOrEvents.messages.map((message, index) => ({
      id: message.id || `${sessionOrEvents.id || 'session'}:${index}`,
      key: `${message.role || 'message'}_message`,
      title: message.role || 'message',
      content: summarizeForStorage(message.content || '', { maxChars: 4000 }),
      session_id: sessionOrEvents.id || null,
      created_at: message.timestamp || message.created_at || new Date(0).toISOString(),
      updated_at: message.timestamp || message.updated_at || message.created_at || new Date(0).toISOString(),
      metadata: {},
    }));
  }
  return [];
}

function compactableEvents(events) {
  return normalizeEvents(events)
    .filter(event => event?.layer === undefined || event.layer === 'session')
    .filter(event => event?.metadata?.summaryType !== SUMMARY_TYPE)
    .filter(event => event?.key !== `session_summary:${event?.session_id || 'global'}`)
    .filter(event => !(event?.key === 'system_event' && event?.metadata?.compaction_event === 'session.compacted'))
    .sort(compareAscending);
}

function latestSummaryRecord(events) {
  return normalizeEvents(events)
    .filter(event => event?.metadata?.summaryType === SUMMARY_TYPE)
    .sort((a, b) => timestamp(b).localeCompare(timestamp(a)))[0] || null;
}

function compareAscending(a, b) {
  return timestamp(a).localeCompare(timestamp(b));
}

function timestamp(event) {
  return event?.created_at || event?.updated_at || event?.createdAt || event?.updatedAt || '';
}

function charCount(events) {
  return events.reduce((total, event) => total + String(event?.content || '').length, 0);
}

function preview(text, maxChars) {
  return String(text || '').replace(/\s+/g, ' ').trim().slice(0, maxChars);
}

function last(items) {
  return items.length ? items[items.length - 1] : null;
}
