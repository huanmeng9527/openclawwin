/**
 * Compaction — Context Window Management
 * 
 * When messages exceed the context window:
 *   1. Count approximate tokens (chars / 4)
 *   2. If over threshold, summarize older messages
 *   3. Replace old messages with summary
 * 
 * Strategies:
 *   - "truncate"  — simply drop oldest messages
 *   - "summarize" — use model to summarize (requires model call)
 */

const CHARS_PER_TOKEN = 4; // rough estimate

export {
  DEFAULT_SESSION_COMPACTION,
  SUMMARY_TYPE,
  SessionCompactor,
  SummaryRecord,
} from './sessionCompactor.js';

/**
 * Count approximate tokens in a message
 */
export function estimateTokens(text) {
  if (!text) return 0;
  return Math.ceil(text.length / CHARS_PER_TOKEN);
}

/**
 * Count total tokens in a message array
 */
export function countMessageTokens(messages) {
  let total = 0;
  for (const msg of messages) {
    total += estimateTokens(msg.content);
    if (msg.tool_calls) {
      total += estimateTokens(JSON.stringify(msg.tool_calls));
    }
  }
  return total;
}

/**
 * Compaction result
 */
export class CompactionResult {
  constructor(messages, removed, summary) {
    this.messages = messages;
    this.removed = removed;
    this.summary = summary;
    this.tokensSaved = countMessageTokens(removed);
  }
}

/**
 * Truncate strategy — drop oldest non-system messages
 */
export function truncateMessages(messages, maxTokens) {
  const currentTokens = countMessageTokens(messages);
  if (currentTokens <= maxTokens) {
    return { messages, removed: [], compacted: false };
  }

  // Keep system messages + recent messages
  const systemMsgs = messages.filter(m => m.role === 'system');
  const nonSystemMsgs = messages.filter(m => m.role !== 'system');

  const targetTokens = Math.floor(maxTokens * 0.8); // leave 20% headroom
  const systemTokens = countMessageTokens(systemMsgs);
  const budget = targetTokens - systemTokens;

  // Keep messages from the end until budget is exhausted
  let used = 0;
  let keepFrom = nonSystemMsgs.length;

  for (let i = nonSystemMsgs.length - 1; i >= 0; i--) {
    const msgTokens = estimateTokens(nonSystemMsgs[i].content);
    if (used + msgTokens > budget) break;
    used += msgTokens;
    keepFrom = i;
  }

  const kept = nonSystemMsgs.slice(keepFrom);
  const removed = nonSystemMsgs.slice(0, keepFrom);

  return {
    messages: [...systemMsgs, ...kept],
    removed,
    compacted: removed.length > 0,
  };
}

/**
 * Summarize strategy — create a summary of removed messages
 * (Doesn't call the model; uses a simple heuristic summary)
 */
export function compactWithSummary(messages, maxTokens) {
  const result = truncateMessages(messages, maxTokens);

  if (!result.compacted) {
    return new CompactionResult(messages, [], null);
  }

  // Build a simple summary of removed messages
  const summaryParts = ['[Previous conversation summary]'];
  const userMsgs = result.removed.filter(m => m.role === 'user');
  const toolMsgs = result.removed.filter(m => m.role === 'tool');

  if (userMsgs.length > 0) {
    summaryParts.push(`User asked ${userMsgs.length} question(s):`);
    for (const msg of userMsgs.slice(0, 5)) {
      const preview = (msg.content || '').slice(0, 100);
      summaryParts.push(`  - ${preview}`);
    }
    if (userMsgs.length > 5) {
      summaryParts.push(`  ... and ${userMsgs.length - 5} more`);
    }
  }

  if (toolMsgs.length > 0) {
    summaryParts.push(`Tool calls: ${toolMsgs.length} tool result(s) were processed.`);
  }

  const summary = summaryParts.join('\n');

  // Insert summary as a system message after existing system messages
  const systemMsgs = result.messages.filter(m => m.role === 'system');
  const otherMsgs = result.messages.filter(m => m.role !== 'system');

  const newMessages = [
    ...systemMsgs,
    { role: 'system', content: summary },
    ...otherMsgs,
  ];

  return new CompactionResult(newMessages, result.removed, summary);
}

/**
 * Auto-compact a message array if it exceeds the context window
 * @param {Array} messages
 * @param {number} maxContextTokens - max context window size
 * @param {Object} [options] - { strategy: 'truncate'|'summarize', reserveTokens: 0 }
 * @returns {{ messages: Array, compacted: boolean, result?: CompactionResult }}
 */
export function autoCompact(messages, maxContextTokens, options = {}) {
  const { strategy = 'summarize', reserveTokens = 0 } = options;
  const budget = maxContextTokens - reserveTokens;

  const currentTokens = countMessageTokens(messages);
  if (currentTokens <= budget) {
    return { messages, compacted: false };
  }

  let result;
  if (strategy === 'truncate') {
    const { messages: kept, removed } = truncateMessages(messages, budget);
    result = new CompactionResult(kept, removed, null);
  } else {
    result = compactWithSummary(messages, budget);
  }

  return {
    messages: result.messages,
    compacted: true,
    result,
  };
}
