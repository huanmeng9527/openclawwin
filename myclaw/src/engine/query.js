/**
 * QueryEngine — Central orchestrator (inspired by Claude Code's QueryEngine)
 * 
 * Replaces the monolithic AgentLoop with a clear lifecycle:
 * 
 *   submitMessage(prompt)
 *     → fetchSystemPromptParts()     ← config + workspace + skills + plugins
 *     → processUserInput()           ← handle /commands
 *     → query()                      ← main agent loop
 *     │   ├── autoCompact()          ← context compression
 *     │   ├── canUseTool()           ← permission check
 *     │   ├── StreamingToolExecutor  ← parallel/serial tool execution
 *     │   └── recordTranscript()     ← persist to session
 *     → yield result                 ← final response + metadata
 * 
 * Key design:
 *   - AsyncGenerator yields SDKMessage events (streaming)
 *   - Clear separation between prompt assembly, model call, tool execution
 *   - Transcript persistence at every step
 *   - Permission checks before tool execution
 */

import fs from 'node:fs';
import path from 'node:path';
import { createProvider } from '../provider/index.js';
import { ToolRegistry } from '../tools/registry.js';
import { ToolPolicy } from '../tools/policy.js';
import { PermissionRules, canUseTool } from '../tools/permissions.js';
import { StreamingToolExecutor } from '../tools/executor.js';
import { createBuiltinTools } from '../tools/builtin.js';
import { webFetchTool } from '../tools/web_fetch.js';
import { SessionManager } from '../session/index.js';
import { SkillLoader } from '../skills/loader.js';
import { PluginManager } from '../plugins/index.js';
import { SessionCompactor, autoCompact, countMessageTokens } from '../compaction/index.js';
import { streamChat } from '../streaming/index.js';
import { logger } from '../utils/logger.js';
import { MemoryPolicyGate, MemoryProposalStore, MemoryRouter, createMemoryTools } from '../memory/index.js';
import { PromptAssembler } from '../prompt/assembler.js';
import { SessionTranscriptRecorder } from '../session/transcript.js';
import { ApprovalBroker } from '../approval/index.js';
import { AuditLog } from '../audit/index.js';
import { EventBus } from '../events/index.js';

// ── SDK Message types (event stream) ──
export function createMessage(type, data) {
  return { type, ...data, timestamp: new Date().toISOString() };
}

/**
 * QueryEngine — the heart of the agent
 */
export class QueryEngine {
  constructor(config, deps = {}) {
    this.config = config;
    this.provider = deps.provider || createProvider(config.provider);
    this.tools = new ToolRegistry();
    this.policy = new ToolPolicy(config);
    this.permissionRules = deps.permissionRules || new PermissionRules(config);
    this.sessionManager = deps.sessionManager || new SessionManager();
    this.skillLoader = new SkillLoader(config);
    this.pluginManager = new PluginManager();
    this.eventBus = deps.eventBus || new EventBus(config.events || {});
    this.auditLog = deps.auditLog || new AuditLog(config, { eventBus: this.eventBus });
    this.memoryRouter = deps.memoryRouter || new MemoryRouter(config, {
      toolPolicy: this.policy,
      policyGate: new MemoryPolicyGate({ toolPolicy: this.policy }),
      auditLog: this.auditLog,
    });
    this.transcript = deps.transcriptRecorder || new SessionTranscriptRecorder(this.memoryRouter, {
      debug: config.agent?.debugTranscript === true,
    });
    this.approvalBroker = deps.approvalBroker || new ApprovalBroker({
      config,
      transcript: this.transcript,
      auditLog: this.auditLog,
      eventBus: this.eventBus,
    });
    this.memoryProposals = deps.memoryProposals || new MemoryProposalStore({
      config,
      memoryRouter: this.memoryRouter,
      auditLog: this.auditLog,
      approvalBroker: this.approvalBroker,
      eventBus: this.eventBus,
    });
    this.sessionCompactor = deps.sessionCompactor || new SessionCompactor(this.memoryRouter, {
      transcript: this.transcript,
      auditLog: this.auditLog,
      eventBus: this.eventBus,
      config,
      proposalStore: this.memoryProposals,
    });
    this.approvalMode = deps.approvalMode || config.approval?.mode || 'manual';
    this._streaming = config.agent?.streaming ?? true;
    this._maxIterations = config.agent?.maxIterations || 20;

    this._registerTools();
    this.promptAssembler = deps.promptAssembler || new PromptAssembler({
      config,
      toolRegistry: this.tools,
      skillLoader: this.skillLoader,
      pluginManager: this.pluginManager,
      memoryRouter: this.memoryRouter,
    });
  }

  /** Initialize async resources (skills, plugins) */
  async init() {
    await this.skillLoader.loadAll();
    for (const skill of this.skillLoader.getEnabled()) {
      for (const tool of skill.tools) {
        const name = tool.definition?.function?.name;
        if (name && !this.tools.has(name)) {
          this.tools.register(tool.definition, tool.handler);
        }
      }
    }
    return this;
  }

  // ── Phase 1: System Prompt Assembly ──

  async fetchSystemPromptParts(session) {
    return this.promptAssembler.assemble({ session, userInput: '', context: this._runtimeContext(session) });
  }

  // ── Phase 2: Input Processing ──

  processUserInput(input) {
    // Detect /commands
    if (input.startsWith('/')) {
      const [cmd, ...args] = input.slice(1).split(' ');
      return { type: 'command', command: cmd, args: args.join(' '), raw: input };
    }
    return { type: 'message', content: input, raw: input };
  }

  // ── Phase 3: Main Query Loop ──

  async *query(userMessage, session, options = {}) {
    const { stream = this._streaming } = options;

    // Resolve session
    if (typeof session === 'string') {
      try { session = this.sessionManager.load(session); }
      catch { session = this.sessionManager.create(); }
    }
    if (!session) session = this.sessionManager.create();

    // Record user message
    const userMsg = session.addMessage('user', userMessage);
    this.transcript.recordUserMessage({
      session,
      content: userMessage,
      messageId: userMsg.id || `${session.id}:${userMsg.timestamp}:user`,
      context: this._runtimeContext(session, options),
    });

    yield createMessage('user_message', { content: userMessage, sessionId: session.id });

    // Build system prompt after recording the user turn, so L2 can be retrieved.
    const systemPrompt = await this.promptAssembler.assemble({
      session,
      userInput: userMessage,
      context: this._runtimeContext(session, options),
    });

    // Prepare messages
    const maxHistory = (this.config.agent?.maxHistoryTurns || 50) * 2;
    let messages = session.toMessages().slice(-maxHistory);

    // Auto-compact
    const maxContext = (this.config.provider?.maxTokens || 4096) * 3;
    const compaction = autoCompact(messages, maxContext, { reserveTokens: 2000 });
    if (compaction.compacted) {
      messages = compaction.messages;
      yield createMessage('compaction', {
        removed: compaction.result.removed.length,
        tokensSaved: compaction.result.tokensSaved,
      });
    }

    const fullMessages = [{ role: 'system', content: systemPrompt }, ...messages];

    // Run before_model_call hook
    await this.pluginManager.runHook('before_model_call', { messages: fullMessages, session });

    const toolDefs = this.tools.getDefinitions();
    let totalUsage = { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 };
    let iterations = 0;

    while (iterations < this._maxIterations) {
      iterations++;
      yield createMessage('iteration_start', { iteration: iterations });

      // ── Model Call ──
      let assistantMsg;
      let streamed = false;

      if (stream && iterations === 1) {
        try {
          yield createMessage('stream_start', {});
          const result = await streamChat(this.provider, {
            messages: fullMessages,
            tools: toolDefs.length > 0 ? toolDefs : undefined,
          }, {
            onToken: (token) => {
              // Token callback — consumer handles display
            },
          });
          assistantMsg = {
            role: 'assistant',
            content: result.text,
            tool_calls: result.toolCalls.length > 0 ? result.toolCalls : undefined,
          };
          streamed = true;
          yield createMessage('stream_end', { text: result.text });
        } catch (err) {
          logger.debug(`Streaming failed, fallback: ${err.message}`);
        }
      }

      if (!assistantMsg) {
        const response = await this.provider.chat({
          messages: fullMessages,
          tools: toolDefs.length > 0 ? toolDefs : undefined,
        });
        assistantMsg = response.choices?.[0]?.message;
        if (response.usage) {
          totalUsage.prompt_tokens += response.usage.prompt_tokens || 0;
          totalUsage.completion_tokens += response.usage.completion_tokens || 0;
          totalUsage.total_tokens += response.usage.total_tokens || 0;
        }
      }

      if (!assistantMsg) throw new Error('No message in model response');

      // Run after_model_call hook
      await this.pluginManager.runHook('after_model_call', { message: assistantMsg, session });

      // Record assistant message
      const msgExtra = assistantMsg.tool_calls ? { tool_calls: assistantMsg.tool_calls } : {};
      session.addMessage('assistant', assistantMsg.content || '', msgExtra);
      this.transcript.recordAssistantMessage({
        session,
        content: assistantMsg.content || '',
        context: this._runtimeContext(session, options),
      });
      fullMessages.push(assistantMsg);

      yield createMessage('assistant_message', {
        content: assistantMsg.content || '',
        hasToolCalls: !!(assistantMsg.tool_calls?.length),
      });

      // ── Tool Execution ──
      if (assistantMsg.tool_calls?.length > 0) {
        const executor = new StreamingToolExecutor(this.tools, this.policy, this.pluginManager, {
          transcript: this.transcript,
          session,
          context: this._runtimeContext(session, options),
          rules: this.permissionRules,
          approvalBroker: this.approvalBroker,
          approvalMode: options.approvalMode || this.approvalMode,
          auditLog: this.auditLog,
          eventBus: this.eventBus,
        });
        const toolResults = await executor.executeAll(assistantMsg.tool_calls);

        for (const { toolCall, result, denied } of toolResults) {
          // Record tool result
          session.addMessage('tool', result, { tool_call_id: toolCall.id });
          fullMessages.push({ role: 'tool', tool_call_id: toolCall.id, content: result });

          yield createMessage('tool_result', {
            toolName: toolCall.function.name,
            result: result.slice(0, 500),
            denied,
          });
        }

        continue; // Loop back for model to process tool results
      }

      // ── Final Response ──
      const text = assistantMsg.content || '';

      // Run agent_end hook
      await this.pluginManager.runHook('agent_end', { text, session, usage: totalUsage, iterations });

      const sessionCompaction = this._maybeCompactSession(session, options);
      if (sessionCompaction) {
        yield createMessage('session_compaction', {
          summaryId: sessionCompaction.id,
          sessionId: session.id,
          eventCount: sessionCompaction.metadata?.eventCount || 0,
        });
      }

      // Save session
      this.sessionManager.save(session);

      yield createMessage('result', {
        text,
        sessionId: session.id,
        usage: totalUsage,
        iterations,
        compacted: compaction.compacted,
        sessionCompacted: !!sessionCompaction,
      });

      return; // Done
    }

    // Max iterations exceeded
    const text = 'Error: Maximum tool iterations reached.';
    session.addMessage('assistant', text);
    this.sessionManager.save(session);

    yield createMessage('error', { text, reason: 'max_iterations' });
  }

  // ── Transcript persistence ──

  _recordTranscript(session, role, content) {
    const context = this._runtimeContext(session);
    if (role === 'user') return this.transcript.recordUserMessage({ session, content, context });
    if (role === 'assistant') return this.transcript.recordAssistantMessage({ session, content, context });
    return this.transcript.recordSystemEvent({ session, content, context, metadata: { role } });
  }

  // ── Tool registration ──

  _registerTools() {
    const allTools = [
      ...createBuiltinTools(this.config),
      webFetchTool,
      ...createMemoryTools(this.memoryRouter, this._memoryToolContext()),
    ];
    for (const tool of allTools) {
      const name = tool.definition.function.name;
      if (this.policy.isAllowed(name) || this.policy.needsApproval(name)) {
        this.tools.register(tool.definition, tool.handler);
      }
    }
  }

  _runtimeContext(session, options = {}) {
    return {
      session_id: session?.id || null,
      agent_id: this.config.agent?.name || 'myclaw',
      user_id: options.userId || options.user_id || null,
      lane_id: options.laneId || options.lane_id || 'main',
      permissions: options.permissions || this.config.memory?.runtimePermissions || [],
    };
  }

  _memoryToolContext() {
    return {
      agent_id: this.config.agent?.name || 'myclaw',
      lane_id: 'tool',
      permissions: this.config.memory?.toolPermissions || [],
    };
  }

  _maybeCompactSession(session, options = {}) {
    try {
      return this.sessionCompactor?.compactSession?.(
        session.id,
        this._runtimeContext(session, options),
        options.memoryCompaction || {}
      );
    } catch (err) {
      logger.debug(`Session compaction skipped: ${err.message}`);
      return null;
    }
  }

  // ── Convenience: run and collect all events ──

  async run(userMessage, session, options = {}) {
    const events = [];
    let result = null;

    for await (const event of this.query(userMessage, session, options)) {
      events.push(event);
      if (event.type === 'result' || event.type === 'error') {
        result = event;
      }
    }

    return {
      text: result?.text || '',
      session: await this._resolveSession(result?.sessionId),
      usage: result?.usage || { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 },
      iterations: result?.iterations || 0,
      compacted: result?.compacted || false,
      sessionCompacted: result?.sessionCompacted || false,
      events,
    };
  }

  async _resolveSession(id) {
    if (!id) return null;
    try { return this.sessionManager.load(id); }
    catch { return null; }
  }

  // ── Public API getters ──

  getToolNames() { return this.tools.names(); }
  get sessions() { return this.sessionManager; }
  get skills() { return this.skillLoader; }
  get plugins() { return this.pluginManager; }
}
