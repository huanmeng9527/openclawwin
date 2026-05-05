/**
 * Tool Policy
 * 
 * Controls which tools are enabled, disabled, or require approval.
 * Policies: "allow" | "deny" | "ask"
 */

export class ToolPolicy {
  constructor(config = {}) {
    // Default policies per tool name
    this._policies = new Map();

    // Set from config
    if (config.tools?.enabled) {
      for (const name of config.tools.enabled) {
        this._policies.set(name, 'allow');
      }
    }

    // Override with explicit policies if present
    if (config.tools?.policies) {
      for (const [name, policy] of Object.entries(config.tools.policies)) {
        this._policies.set(name, policy);
      }
    }
  }

  /** Check if a tool is allowed */
  isAllowed(toolName) {
    const policy = this._policies.get(toolName);
    return policy === 'allow';
  }

  /** Check if a tool requires user approval */
  needsApproval(toolName) {
    const policy = this._policies.get(toolName);
    return policy === 'ask';
  }

  /** Check if a tool is denied */
  isDenied(toolName) {
    const policy = this._policies.get(toolName);
    return policy === 'deny' || !this._policies.has(toolName);
  }

  /** Get all allowed tool names */
  getAllowed() {
    return [...this._policies.entries()]
      .filter(([, p]) => p === 'allow')
      .map(([name]) => name);
  }

  /** Set policy for a tool */
  set(toolName, policy) {
    if (!['allow', 'deny', 'ask'].includes(policy)) {
      throw new Error(`Invalid policy: ${policy}. Use allow/deny/ask`);
    }
    this._policies.set(toolName, policy);
  }

  /** Get policy summary */
  summary() {
    const result = { allow: [], deny: [], ask: [] };
    for (const [name, policy] of this._policies) {
      result[policy].push(name);
    }
    return result;
  }
}
