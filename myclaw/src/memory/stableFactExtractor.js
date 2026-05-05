import { redactSecretText, truncate } from './sanitizer.js';

const DEFAULT_OPTIONS = {
  minConfidence: 0.7,
  maxCandidates: 5,
  maxCandidateChars: 500,
};

const STABLE_KEYWORDS = [
  'remember',
  'preference',
  'prefer',
  'always',
  'never',
  'project',
  'decision',
  'decide',
  'fact',
  'long-term',
  'long term',
  '用户偏好',
  '偏好',
  '决定',
  '决策',
  '长期',
  '记住',
  '项目',
  '事实',
];

const NOISE_RE = /(tool_call|tool_result|tool_error|approval\.|audit|stack trace|traceback|error:|workspace sandbox|session\.compacted)/i;
const SUMMARY_TYPE = 'l2_session_summary';

export class StableFactExtractor {
  constructor(options = {}) {
    this.options = {
      ...DEFAULT_OPTIONS,
      ...(options.memory?.proposals || {}),
      ...options,
    };
  }

  extractCandidatesFromSummary(summaryRecord, context = {}, options = {}) {
    const settings = this._settings(options);
    const metadata = summaryRecord?.metadata || {};
    const sessionId = summaryRecord?.session_id || summaryRecord?.sessionId || context.session_id || null;
    const sourceEventIds = metadata.sourceEventIds || summaryRecord?.sourceEventIds || [];
    return this._extractFromText(summaryRecord?.content || '', {
      ...settings,
      sourceSessionId: sessionId,
      sourceSummaryId: summaryRecord?.id || null,
      sourceEventIds,
      namespace: context.namespace || summaryRecord?.namespace || 'default',
    });
  }

  extractCandidatesFromEvents(events, context = {}, options = {}) {
    const settings = this._settings(options);
    const filtered = (events || [])
      .filter(event => !isNoiseEvent(event))
      .filter(event => ['user_message', 'assistant_message'].includes(event.key || event.metadata?.event_type));
    const text = filtered.map(event => event.content || '').join('\n');
    const sourceEventIds = filtered.map(event => event.id).filter(Boolean);
    return this._extractFromText(text, {
      ...settings,
      sourceSessionId: context.session_id || filtered.find(event => event.session_id)?.session_id || null,
      sourceSummaryId: context.sourceSummaryId || null,
      sourceEventIds,
      namespace: context.namespace || 'default',
    });
  }

  _extractFromText(text, options = {}) {
    const settings = this._settings(options);
    const candidates = [];
    const seen = new Set();

    for (const sentence of splitSentences(text)) {
      const content = cleanupCandidate(sentence, settings.maxCandidateChars);
      if (!content || content.length < 12) continue;
      if (isNoiseText(content)) continue;
      if (!hasStableKeyword(content)) continue;

      const type = classifyCandidate(content);
      const confidence = confidenceFor(type, content);
      if (confidence < settings.minConfidence) continue;
      const signature = `${type}:${content.toLowerCase()}`;
      if (seen.has(signature)) continue;
      seen.add(signature);

      candidates.push({
        type,
        content,
        title: titleFor(type, content),
        tags: tagsFor(type, content),
        namespace: options.namespace || 'default',
        confidence,
        reason: reasonFor(type, content),
        sourceSessionId: options.sourceSessionId || null,
        sourceSummaryId: options.sourceSummaryId || null,
        sourceEventIds: options.sourceEventIds || [],
        targetLayer: 'semantic',
        targetHint: targetHintFor(type),
      });

      if (candidates.length >= settings.maxCandidates) break;
    }

    return candidates;
  }

  _settings(options = {}) {
    return {
      ...this.options,
      ...options,
    };
  }
}

function splitSentences(text) {
  return String(text || '')
    .replace(/\r/g, '\n')
    .split(/[\n。！？!?]+|(?<=[.])\s+/u)
    .map(line => line.replace(/^[-*]\s*/, '').trim())
    .filter(Boolean);
}

function cleanupCandidate(text, maxChars) {
  return truncate(redactSecretText(String(text || '').replace(/\s+/g, ' ').trim()), maxChars);
}

function hasStableKeyword(text) {
  const value = text.toLowerCase();
  return STABLE_KEYWORDS.some(keyword => value.includes(keyword.toLowerCase()));
}

function isNoiseText(text) {
  if (!text) return true;
  if (NOISE_RE.test(text)) return true;
  if (/^\[generated deterministic l2 session summary\]/i.test(text)) return true;
  if (/^events summarized:/i.test(text)) return true;
  if (/^session:/i.test(text)) return true;
  return false;
}

function isNoiseEvent(event) {
  if (!event) return true;
  if (event.metadata?.summaryType === SUMMARY_TYPE) return false;
  const key = event.key || event.metadata?.event_type || '';
  if (['tool_call', 'tool_result', 'tool_error', 'system_event'].includes(key)) return true;
  return isNoiseText(event.content || '');
}

function classifyCandidate(content) {
  const value = content.toLowerCase();
  if (/(preference|prefer|用户偏好|偏好|喜欢)/i.test(value)) return 'preference';
  if (/(decision|decide|决定|决策)/i.test(value)) return 'decision';
  if (/(project|项目)/i.test(value)) return 'project_note';
  return 'semantic_fact';
}

function confidenceFor(type, content) {
  let score = type === 'semantic_fact' ? 0.76 : 0.84;
  if (/(always|never|长期|记住|remember)/i.test(content)) score += 0.05;
  if (/(maybe|temporary|临时|today|本次)/i.test(content)) score -= 0.15;
  return Math.max(0, Math.min(0.95, Number(score.toFixed(2))));
}

function titleFor(type, content) {
  const label = {
    semantic_fact: 'Candidate fact',
    preference: 'Candidate preference',
    project_note: 'Candidate project note',
    decision: 'Candidate decision',
  }[type] || 'Candidate memory';
  return `${label}: ${content.slice(0, 60)}`;
}

function tagsFor(type, content) {
  const tags = ['proposal', type];
  if (/(project|项目)/i.test(content)) tags.push('project');
  if (/(preference|prefer|偏好|喜欢)/i.test(content)) tags.push('preference');
  if (/(decision|决定|决策)/i.test(content)) tags.push('decision');
  return Array.from(new Set(tags));
}

function reasonFor(type, content) {
  return `${type} candidate from stable keyword heuristic: ${matchedKeywords(content).join(', ')}`;
}

function matchedKeywords(content) {
  const value = content.toLowerCase();
  return STABLE_KEYWORDS.filter(keyword => value.includes(keyword.toLowerCase())).slice(0, 4);
}

function targetHintFor(type) {
  if (type === 'preference') return 'preferences';
  if (type === 'project_note') return 'project_notes';
  if (type === 'decision') return 'decisions';
  return 'facts';
}
