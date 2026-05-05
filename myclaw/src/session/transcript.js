import { summarizeForStorage } from '../memory/sanitizer.js';
import { createId } from '../memory/models.js';

const EVENT_TYPES = new Set([
  'user_message',
  'assistant_message',
  'tool_call',
  'tool_result',
  'tool_error',
  'system_event',
]);

export class SessionTranscriptRecorder {
  constructor(memoryRouter, options = {}) {
    this.memoryRouter = memoryRouter;
    this.maxChars = options.maxChars || 4000;
    this.debug = options.debug || false;
  }

  recordUserMessage({ session, content, messageId, context = {} }) {
    return this._record('user_message', { session, content, eventId: messageId, context });
  }

  recordAssistantMessage({ session, content, messageId, context = {} }) {
    return this._record('assistant_message', { session, content, eventId: messageId, context });
  }

  recordToolCall({ session, toolCall, args = {}, context = {} }) {
    const toolName = toolCall?.function?.name || toolCall?.name || 'unknown_tool';
    return this._record('tool_call', {
      session,
      eventId: toolCall?.id,
      title: toolName,
      content: summarizeForStorage({ tool: toolName, args }, { maxChars: this.maxChars }),
      metadata: { tool_name: toolName, tool_call_id: toolCall?.id || null },
      context,
    });
  }

  recordToolResult({ session, toolCall, result, context = {} }) {
    const toolName = toolCall?.function?.name || toolCall?.name || 'unknown_tool';
    return this._record('tool_result', {
      session,
      eventId: toolCall?.id ? `${toolCall.id}:result` : null,
      title: toolName,
      content: summarizeForStorage(result, { maxChars: this.maxChars }),
      metadata: { tool_name: toolName, tool_call_id: toolCall?.id || null },
      context,
    });
  }

  recordToolError({ session, toolCall, error, context = {} }) {
    const toolName = toolCall?.function?.name || toolCall?.name || 'unknown_tool';
    return this._record('tool_error', {
      session,
      eventId: toolCall?.id ? `${toolCall.id}:error` : null,
      title: toolName,
      content: summarizeForStorage(error, { maxChars: this.maxChars, debug: this.debug }),
      metadata: { tool_name: toolName, tool_call_id: toolCall?.id || null },
      risk_level: 'medium',
      context,
    });
  }

  recordSystemEvent({ session, content, eventId, context = {}, metadata = {} }) {
    return this._record('system_event', { session, content, eventId, context, metadata });
  }

  _record(type, { session, content, eventId, context = {}, title, metadata = {}, risk_level = 'low' }) {
    if (!EVENT_TYPES.has(type)) throw new Error(`Invalid transcript event type: ${type}`);
    const sessionId = session?.id || context.session_id || 'global';
    return this.memoryRouter.appendSessionEvent({
      event_id: eventId || createId(type),
      event_type: type,
      session_id: sessionId,
      agent_id: context.agent_id,
      user_id: context.user_id,
      lane_id: context.lane_id,
      title: title || type,
      content: summarizeForStorage(content, { maxChars: this.maxChars, debug: this.debug }),
      metadata,
      risk_level,
    }, {
      session_id: sessionId,
      agent_id: context.agent_id,
      user_id: context.user_id,
      lane_id: context.lane_id,
    });
  }
}
