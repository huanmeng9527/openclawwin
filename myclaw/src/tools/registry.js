/**
 * Tool Registry — Enhanced with ToolInterface support
 * 
 * Supports both legacy (definition + handler) and new ToolInterface format.
 * New tools use validateInput/call lifecycle.
 */

import { ToolInterface, TOOL_CAPABILITIES } from './interface.js';

export class ToolRegistry {
  constructor() {
    this._tools = new Map();       // name → OpenAI definition
    this._handlers = new Map();    // name → handler function
    this._interfaces = new Map();  // name → ToolInterface
  }

  /**
   * Register a tool (legacy format)
   */
  register(definition, handler) {
    const name = definition.function?.name || definition.name;
    if (!name) throw new Error('Tool must have a name');

    this._tools.set(name, definition);
    this._handlers.set(name, handler);

    // Auto-create ToolInterface with known capabilities
    const caps = TOOL_CAPABILITIES[name] || {};
    this._interfaces.set(name, new ToolInterface({
      name,
      description: definition.function?.description || '',
      parameters: definition.function?.parameters || {},
      handler,
      capabilities: caps,
    }));

    return this;
  }

  /**
   * Register a ToolInterface directly
   */
  registerInterface(toolInterface) {
    const name = toolInterface.name;
    this._interfaces.set(name, toolInterface);
    this._tools.set(name, toolInterface.toDefinition());
    this._handlers.set(name, (args) => toolInterface.call(args));
    return this;
  }

  /**
   * Get OpenAI tool definitions
   */
  getDefinitions() {
    return Array.from(this._tools.values());
  }

  /**
   * Get ToolInterface by name
   */
  getInterface(name) {
    return this._interfaces.get(name);
  }

  /**
   * Execute a tool by name
   */
  async execute(name, args) {
    const iface = this._interfaces.get(name);
    if (iface) {
      return iface.call(args);
    }

    // Fallback to direct handler
    const handler = this._handlers.get(name);
    if (!handler) throw new Error(`Unknown tool: ${name}`);

    try {
      const result = await handler(args);
      return typeof result === 'string' ? result : JSON.stringify(result);
    } catch (err) {
      return `Error executing ${name}: ${err.message}`;
    }
  }

  has(name) { return this._tools.has(name); }
  names() { return Array.from(this._tools.keys()); }
}

// ── Helper to create tool definitions ──
export function makeTool(name, description, parameters, handler) {
  return {
    definition: {
      type: 'function',
      function: { name, description, parameters },
    },
    handler,
  };
}
