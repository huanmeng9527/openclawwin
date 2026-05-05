/**
 * StreamingToolExecutor — Parallel/serial tool execution (inspired by Claude Code)
 * 
 * Tool execution strategy:
 *   1. Check if each tool is concurrency-safe
 *   2. Group: concurrent-safe tools run in parallel, others run serially
 *   3. Permission check before each execution
 *   4. Results collected in original order
 */

import { canUseTool } from './permissions.js';
import { TOOL_CAPABILITIES } from './interface.js';
import { logger } from '../utils/logger.js';
import { APPROVAL_PERMISSIONS, APPROVAL_STATUS, APPROVAL_TYPES } from '../approval/index.js';
import { summarizeForStorage } from '../memory/sanitizer.js';

export class StreamingToolExecutor {
  constructor(registry, policy, plugins, options = {}) {
    this.registry = registry;
    this.policy = policy;
    this.plugins = plugins;
    this.transcript = options.transcript || null;
    this.session = options.session || null;
    this.context = options.context || {};
    this.rules = options.rules || null;
    this.approvalBroker = options.approvalBroker || null;
    this.approvalMode = options.approvalMode || 'manual';
    this.auditLog = options.auditLog || null;
    this.eventBus = options.eventBus || null;
  }

  /**
   * Execute all tool calls, respecting concurrency safety
   * @param {Array} toolCalls - OpenAI tool_calls array
   * @returns {Promise<Array<{ toolCall, result, denied, error }>>}
   */
  async executeAll(toolCalls) {
    // Partition into concurrent-safe and serial groups
    const { concurrent, serial } = this._partition(toolCalls);

    const results = [];

    // Run concurrent tools in parallel
    if (concurrent.length > 0) {
      const concurrentResults = await Promise.all(
        concurrent.map(tc => this._executeOne(tc))
      );
      results.push(...concurrentResults);
    }

    // Run serial tools one by one
    for (const tc of serial) {
      const result = await this._executeOne(tc);
      results.push(result);
    }

    // Re-sort to match original order
    const orderMap = new Map(toolCalls.map((tc, i) => [tc.id, i]));
    results.sort((a, b) => (orderMap.get(a.toolCall.id) || 0) - (orderMap.get(b.toolCall.id) || 0));

    return results;
  }

  /**
   * Execute a single tool call with permission check
   */
  async _executeOne(toolCall) {
    const fnName = toolCall.function.name;
    let fnArgs = {};
    try {
      fnArgs = JSON.parse(toolCall.function.arguments || '{}');
    } catch { fnArgs = {}; }

    this.transcript?.recordToolCall({
      session: this.session,
      toolCall,
      args: fnArgs,
      context: this.context,
    });

    const approvedApproval = this._getApprovedApproval(fnArgs.approvalId, fnName);

    // Permission check
    const permResult = await canUseTool({
      toolName: fnName,
      args: fnArgs,
      policy: this.policy,
      registry: this.registry,
      plugins: this.plugins,
      rules: this.rules,
      context: {
        ...this.context,
        approval: approvedApproval ? {
          id: approvedApproval.id,
          status: approvedApproval.status,
          toolName: approvedApproval.toolName,
        } : undefined,
      },
    });

    if (!permResult.allowed) {
      if (permResult.approvalRequired || permResult.needsConfirmation) {
        this._recordAudit('tool.policy.ask', {
          toolName: fnName,
          decision: 'ask',
          reason: permResult.reason,
          riskLevel: permResult.riskLevel || 'medium',
          metadata: { args: fnArgs },
        });
        const approvalResult = await this._handleApprovalRequired({ toolCall, fnName, fnArgs, permResult });
        if (approvalResult.retryApproved) return this._executeOne(approvalResult.toolCall);
        return approvalResult;
      }

      const reason = permResult.reason || 'Not allowed';
      this._recordAudit('tool.policy.deny', {
        toolName: fnName,
        decision: 'deny',
        reason,
        riskLevel: 'medium',
        metadata: { args: fnArgs },
      });
      logger.debug(`  Denied: ${fnName} — ${reason}`);
      this.transcript?.recordToolError({
        session: this.session,
        toolCall,
        error: { message: reason, denied: true, needsConfirmation: permResult.needsConfirmation === true },
        context: this.context,
      });
      return {
        toolCall,
        result: `Error: ${reason}`,
        denied: true,
        error: null,
      };
    }

    this._recordAudit('tool.policy.allow', {
      toolName: fnName,
      decision: 'allow',
      reason: approvedApproval ? 'approved approval decision present' : 'policy allowed',
      approvalId: approvedApproval?.id || null,
      metadata: { args: fnArgs },
    });

    // Validate input
    const toolInterface = this.registry.getInterface?.(fnName);
    if (toolInterface) {
      const validation = toolInterface.validateInput(fnArgs);
      if (!validation.valid) {
        this._recordAudit('tool.execution.error', {
          toolName: fnName,
          decision: 'error',
          reason: `Invalid input: ${validation.errors.join(', ')}`,
          metadata: { args: fnArgs },
        });
        this.transcript?.recordToolError({
          session: this.session,
          toolCall,
          error: { message: `Invalid input: ${validation.errors.join(', ')}` },
          context: this.context,
        });
        return {
          toolCall,
          result: `Error: Invalid input — ${validation.errors.join(', ')}`,
          denied: false,
          error: 'validation',
        };
      }
    }

    // Execute
    logger.debug(`  Execute: ${fnName}`);
    this._recordAudit('tool.execution.start', {
      toolName: fnName,
      decision: 'allow',
      reason: 'tool execution started',
      approvalId: approvedApproval?.id || null,
      metadata: { args: fnArgs },
    });
    try {
      const result = await this.registry.execute(fnName, fnArgs, this.context);
      if (typeof result === 'string' && result.startsWith('Error: Workspace sandbox denied path')) {
        this._recordAudit('workspace.sandbox.deny', {
          toolName: fnName,
          decision: 'deny',
          reason: result,
          metadata: { args: fnArgs },
        });
      }
      if (typeof result === 'string' && result.startsWith('Error')) {
        this._recordAudit('tool.execution.error', {
          toolName: fnName,
          decision: 'error',
          reason: result,
          metadata: { args: fnArgs },
        });
      } else {
        this._recordAudit('tool.execution.success', {
          toolName: fnName,
          decision: 'allow',
          reason: 'tool execution succeeded',
          approvalId: approvedApproval?.id || null,
          metadata: { resultSummary: summarizeResult(result) },
        });
      }

      // Run tool_after hook
      if (this.plugins) {
        await this.plugins.runHook('tool_after', { toolName: fnName, args: fnArgs, result });
      }

      this.transcript?.recordToolResult({
        session: this.session,
        toolCall,
        result,
        context: this.context,
      });
      return { toolCall, result, denied: false, error: null };
    } catch (err) {
      this._recordAudit('tool.execution.error', {
        toolName: fnName,
        decision: 'error',
        reason: err.message,
        approvalId: approvedApproval?.id || null,
        metadata: { name: err.name },
      });
      this.transcript?.recordToolError({
        session: this.session,
        toolCall,
        error: err,
        context: this.context,
      });
      return {
        toolCall,
        result: `Error executing ${fnName}: ${err.message}`,
        denied: false,
        error: err.message,
      };
    }
  }

  async _handleApprovalRequired({ toolCall, fnName, fnArgs, permResult }) {
    const reason = permResult.reason || 'Approval required';
    const request = this._submitApprovalRequest({ toolCall, fnName, fnArgs, permResult, reason });

    if (request && this.approvalMode === 'deny' && request.status === APPROVAL_STATUS.PENDING) {
      this.approvalBroker.deny(request.id, {
        ...this.context,
        permissions: [APPROVAL_PERMISSIONS.ADMIN, ...(this.context.permissions || [])],
        decidedBy: 'approvalMode:deny',
      }, 'approvalMode:deny');
    }

    if (request && this.approvalMode === 'auto_for_tests') {
      const approved = this.approvalBroker.approve(request.id, {
        ...this.context,
        permissions: [APPROVAL_PERMISSIONS.TOOL_CALL, ...(this.context.permissions || [])],
        decidedBy: 'auto_for_tests',
      }, 'auto_for_tests');
      return {
        retryApproved: true,
        toolCall: {
          ...toolCall,
          function: {
            ...toolCall.function,
            arguments: JSON.stringify({ ...fnArgs, approvalId: approved.id }),
          },
        },
      };
    }

    const status = request?.status || APPROVAL_STATUS.DENIED;
    const approvalId = request?.id || null;
    const structured = {
      error: 'approval_required',
      approvalId,
      status,
      reason,
    };
    this.transcript?.recordToolError({
      session: this.session,
      toolCall,
      error: { ...structured, denied: true, needsConfirmation: true },
      context: this.context,
    });
    return {
      toolCall,
      result: `Error: ${reason} ${JSON.stringify(structured)}`,
      denied: true,
      error: null,
      approvalId,
      status,
    };
  }

  _submitApprovalRequest({ fnName, fnArgs, permResult, reason }) {
    if (!this.approvalBroker) return null;
    const existing = fnArgs.approvalId ? this.approvalBroker.get(fnArgs.approvalId) : null;
    if (existing) return existing;
    return this.approvalBroker.submit({
      type: APPROVAL_TYPES.TOOL_CALL,
      subject: fnName,
      action: 'execute',
      resource: fnArgs.path || fnArgs.cwd || fnArgs.command || fnName,
      riskLevel: permResult.riskLevel || 'medium',
      reason,
      payload: { tool: fnName, args: fnArgs },
      sessionId: this.context.session_id,
      userId: this.context.user_id,
      agentId: this.context.agent_id,
      toolName: fnName,
    }, this.context);
  }

  _getApprovedApproval(approvalId, fnName) {
    if (!approvalId || !this.approvalBroker) return null;
    const request = this.approvalBroker.get(approvalId);
    if (!request) return null;
    if (request.status !== APPROVAL_STATUS.APPROVED) return null;
    if (request.toolName && request.toolName !== fnName) return null;
    return request;
  }

  _recordAudit(eventType, details = {}) {
    this.auditLog?.write?.({
      eventType,
      subject: details.toolName || '',
      subjectRole: 'tool',
      sessionId: this.context.session_id || null,
      userId: this.context.user_id || null,
      agentId: this.context.agent_id || null,
      action: eventType,
      resource: details.resource || '',
      toolName: details.toolName || null,
      decision: details.decision || null,
      reason: details.reason || '',
      riskLevel: details.riskLevel || 'low',
      approvalId: details.approvalId || null,
      metadata: details.metadata || {},
      source: 'streaming-tool-executor',
    });
    if (shouldPublishToolEvent(eventType)) {
      this.eventBus?.publish?.({
        type: eventType,
        source: 'streaming-tool-executor',
        sessionId: this.context.session_id || null,
        userId: this.context.user_id || null,
        agentId: this.context.agent_id || null,
        approvalId: details.approvalId || null,
        toolName: details.toolName || null,
        decision: details.decision || null,
        riskLevel: details.riskLevel || 'low',
        summary: details.reason || eventType,
        metadata: details.metadata || {},
      });
    }
  }

  /**
   * Partition tool calls into concurrent-safe and serial groups
   */
  _partition(toolCalls) {
    const concurrent = [];
    const serial = [];

    for (const tc of toolCalls) {
      const name = tc.function?.name;
      const caps = TOOL_CAPABILITIES[name];

      if (caps?.concurrencySafe === false || caps?.destructive === true) {
        serial.push(tc);
      } else {
        concurrent.push(tc);
      }
    }

    return { concurrent, serial };
  }
}

function summarizeResult(result) {
  return summarizeForStorage(result, { maxChars: 500 });
}

function shouldPublishToolEvent(eventType) {
  return ['tool.policy.ask', 'tool.policy.deny', 'tool.execution.error'].includes(eventType);
}
