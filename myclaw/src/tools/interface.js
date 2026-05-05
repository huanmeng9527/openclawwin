/**
 * Tool Interface — Enhanced lifecycle (inspired by Claude Code's Tool.ts)
 * 
 * Each tool implements:
 * 
 *   Lifecycle:
 *     validateInput(args)   → { valid, errors[] }
 *     checkPermissions(args, context) → { allowed, reason? }
 *     call(args)            → result string
 * 
 *   Capabilities:
 *     isReadOnly()          → no side effects?
 *     isConcurrencySafe()   → safe to run in parallel?
 *     isDestructive()       → irreversible operation?
 *     isEnabled(config)     → feature flag check
 * 
 *   Metadata:
 *     name, description, parameters (JSON Schema)
 */

export class ToolInterface {
  constructor(definition) {
    this.name = definition.name;
    this.description = definition.description || '';
    this.parameters = definition.parameters || { type: 'object', properties: {} };
    this._handler = definition.handler;
    this._capabilities = definition.capabilities || {};
  }

  // ── Lifecycle ──

  validateInput(args) {
    // Default: check required fields
    const required = this.parameters.required || [];
    const errors = [];
    for (const field of required) {
      if (args[field] === undefined || args[field] === null) {
        errors.push(`Missing required field: ${field}`);
      }
    }
    return { valid: errors.length === 0, errors };
  }

  async checkPermissions(args, context = {}) {
    // Default: check policy
    const policy = context.policy;
    if (policy && policy.isDenied(this.name)) {
      return { allowed: false, reason: `Tool "${this.name}" is denied by policy` };
    }
    return { allowed: true };
  }

  async call(args) {
    if (!this._handler) throw new Error(`No handler for tool: ${this.name}`);
    return this._handler(args);
  }

  // ── Capabilities ──

  isReadOnly() {
    return this._capabilities.readOnly ?? false;
  }

  isConcurrencySafe() {
    return this._capabilities.concurrencySafe ?? true;
  }

  isDestructive() {
    return this._capabilities.destructive ?? false;
  }

  isEnabled(config) {
    const enabled = config?.tools?.enabled || [];
    return enabled.includes(this.name);
  }

  // ── OpenAI tool definition ──

  toDefinition() {
    return {
      type: 'function',
      function: {
        name: this.name,
        description: this.description,
        parameters: this.parameters,
      },
    };
  }
}

/**
 * buildTool — factory to create a ToolInterface
 */
export function buildTool(definition) {
  return new ToolInterface(definition);
}

/**
 * Tool presets — mark known tools with their capabilities
 */
export const TOOL_CAPABILITIES = {
  read:       { readOnly: true,  concurrencySafe: true,  destructive: false },
  write:      { readOnly: false, concurrencySafe: true,  destructive: false },
  edit:       { readOnly: false, concurrencySafe: false, destructive: false },
  exec:       { readOnly: false, concurrencySafe: false, destructive: true },
  list_files: { readOnly: true,  concurrencySafe: true,  destructive: false },
  web_fetch:  { readOnly: true,  concurrencySafe: true,  destructive: false },
  grep:       { readOnly: true,  concurrencySafe: true,  destructive: false },
  glob:       { readOnly: true,  concurrencySafe: true,  destructive: false },
};
