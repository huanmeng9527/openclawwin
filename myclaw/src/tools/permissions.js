/**
 * Tool Permissions — Permission rule engine (inspired by Claude Code's useCanUseTool)
 * 
 * Permission flow:
 *   1. Policy check (allow/deny/ask)
 *   2. Tool-specific checkPermissions()
 *   3. Capability check (destructive? → require confirmation)
 *   4. Plugin hooks (tool_before)
 * 
 * Returns: { allowed, reason?, needsConfirmation? }
 */

import { TOOL_CAPABILITIES } from './interface.js';
import { logger } from '../utils/logger.js';

/**
 * Check if a tool call is allowed
 * 
 * @param {Object} params
 * @param {string} params.toolName
 * @param {Object} params.args - tool arguments
 * @param {ToolPolicy} params.policy
 * @param {ToolRegistry} params.registry
 * @param {PluginManager} params.plugins
 * @param {Object} params.context - additional context (session, user, etc.)
 * @returns {Promise<{ allowed: boolean, reason?: string, needsConfirmation?: boolean }>}
 */
export async function canUseTool({ toolName, args, policy, registry, plugins, rules = null, context = {} }) {
  // 1. Policy check
  if (policy.isDenied(toolName)) {
    return { allowed: false, reason: `Tool "${toolName}" is denied by policy` };
  }

  if (policy.needsApproval(toolName) && !hasApprovedApproval(context, toolName)) {
    return {
      allowed: false,
      reason: `Tool "${toolName}" requires approval`,
      needsConfirmation: true,
      approvalRequired: true,
      approvalType: 'tool_call',
      riskLevel: 'medium',
    };
  }

  // 2. Configurable permission rules
  const ruleResult = rules?.check?.(toolName, args);
  if (ruleResult?.action === 'deny') {
    return {
      allowed: false,
      reason: ruleResult.rule?.reason || `Tool "${toolName}" blocked by permission rule`,
      rule: ruleResult.rule,
    };
  }
  if (ruleResult?.action === 'ask' && !hasApprovedApproval(context, toolName)) {
    return {
      allowed: false,
      reason: `Tool "${toolName}" requires approval by permission rule`,
      needsConfirmation: true,
      approvalRequired: true,
      approvalType: 'tool_call',
      riskLevel: ruleResult.rule?.riskLevel || 'medium',
      rule: ruleResult.rule,
    };
  }

  // 3. Tool-specific permission check
  const tool = registry.getInterface?.(toolName);
  if (tool) {
    const permResult = await tool.checkPermissions(args, { policy, ...context });
    if (!permResult.allowed) {
      return { allowed: false, reason: permResult.reason };
    }
  }

  // 3. Capability check — destructive tools need confirmation
  const caps = TOOL_CAPABILITIES[toolName];
  if (caps?.destructive && !context.forceAllow && !hasApprovedApproval(context, toolName)) {
    return {
      allowed: false,
      reason: `Tool "${toolName}" is destructive and requires confirmation`,
      needsConfirmation: true,
      approvalRequired: true,
      approvalType: 'tool_call',
      riskLevel: 'high',
    };
  }

  // 5. Plugin hook (tool_before can veto)
  if (plugins) {
    const hookCtx = await plugins.runHook('tool_before', {
      toolName,
      args,
      allowed: true,
    });
    if (hookCtx.allowed === false) {
      return { allowed: false, reason: hookCtx.reason || `Blocked by plugin` };
    }
  }

  return { allowed: true };
}

export function hasApprovedApproval(context = {}, toolName = null) {
  const approval = context.approval || {};
  if (approval.status !== 'approved') return false;
  if (toolName && approval.toolName && approval.toolName !== toolName) return false;
  return true;
}

/**
 * Permission rules — configurable in myclaw.json
 * 
 * tools.policies: {
 *   "exec": "ask",
 *   "write": "allow",
 *   "read": "allow"
 * }
 * 
 * tools.rules: [
 *   { tool: "exec", pattern: "rm -rf*", action: "deny" },
 *   { tool: "exec", pattern: "git push*", action: "ask" },
 *   { tool: "write", path: "/etc/*", action: "deny" }
 * ]
 */
export class PermissionRules {
  constructor(config = {}) {
    this._rules = config.tools?.rules || [];
    this._exec = config.tools?.exec || {};
  }

  /**
   * Check rules for a tool call
   * @returns {{ action: 'allow'|'deny'|'ask', rule?: Object }}
   */
  check(toolName, args) {
    if (toolName === 'exec') {
      const execPolicy = evaluateExecCommandPolicy(args.command || '', this._exec);
      if (!execPolicy.allowed) {
        return { action: 'deny', rule: execPolicy };
      }
    }

    for (const rule of this._rules) {
      if (rule.tool && rule.tool !== toolName) continue;

      // Pattern matching on command (for exec)
      if (rule.pattern && args.command) {
        const regex = new RegExp(rule.pattern.replace(/\*/g, '.*'));
        if (regex.test(args.command)) {
          return { action: rule.action || 'deny', rule };
        }
      }

      // Path matching (for read/write/edit)
      if (rule.path && args.path) {
        const regex = new RegExp(rule.path.replace(/\*/g, '.*'));
        if (regex.test(args.path)) {
          return { action: rule.action || 'deny', rule };
        }
      }
    }

    return { action: 'allow' };
  }
}

export function evaluateExecCommandPolicy(command, execConfig = {}) {
  const value = String(command || '').trim();
  const deniedCommands = execConfig.deniedCommands || [];
  const allowedCommands = execConfig.allowedCommands || [];

  for (const pattern of deniedCommands) {
    if (commandMatches(pattern, value)) {
      return { allowed: false, reason: `Command blocked by exec.deniedCommands: ${pattern}` };
    }
  }

  if (allowedCommands.length > 0) {
    for (const pattern of allowedCommands) {
      if (commandMatches(pattern, value)) {
        return { allowed: true };
      }
    }
    return { allowed: false, reason: 'Command is not listed in exec.allowedCommands' };
  }

  return { allowed: true };
}

export function commandMatches(pattern, command) {
  const expected = String(pattern || '').trim();
  const value = String(command || '').trim();
  if (!expected) return false;
  if (expected.includes('*')) {
    const regex = new RegExp(`^${expected.split('*').map(escapeRegExp).join('.*')}$`, 'i');
    return regex.test(value);
  }
  return value === expected || value.startsWith(`${expected} `);
}

function escapeRegExp(value) {
  return value.replace(/[|\\{}()[\]^$+?.]/g, '\\$&');
}
