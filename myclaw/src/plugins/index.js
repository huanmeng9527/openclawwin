/**
 * Plugin System — Hook-based lifecycle extension
 * 
 * Hooks:
 *   before_prompt_build  — inject context before system prompt is finalized
 *   before_model_call    — modify messages before sending to model
 *   after_model_call     — process model response
 *   agent_end            — post-processing after agent loop completes
 *   tool_before          — intercept before tool execution
 *   tool_after           — intercept after tool execution
 */

export const HOOK_NAMES = [
  'before_prompt_build',
  'before_model_call',
  'after_model_call',
  'agent_end',
  'tool_before',
  'tool_after',
];

export class PluginManager {
  constructor() {
    this._hooks = new Map();
    for (const name of HOOK_NAMES) {
      this._hooks.set(name, []);
    }
    this._plugins = new Map();
  }

  /**
   * Register a plugin
   * @param {Object} plugin - { name, hooks: { hookName: handler } }
   */
  register(plugin) {
    if (!plugin.name) throw new Error('Plugin must have a name');
    if (this._plugins.has(plugin.name)) {
      throw new Error(`Plugin already registered: ${plugin.name}`);
    }

    this._plugins.set(plugin.name, plugin);

    // Register hooks
    if (plugin.hooks) {
      for (const [hookName, handler] of Object.entries(plugin.hooks)) {
        if (!this._hooks.has(hookName)) {
          throw new Error(`Unknown hook: ${hookName}. Available: ${HOOK_NAMES.join(', ')}`);
        }
        this._hooks.get(hookName).push({ plugin: plugin.name, handler });
      }
    }

    return this;
  }

  /**
   * Run a hook — calls all registered handlers in order
   * @param {string} hookName
   * @param {Object} context - shared context object passed to all handlers
   * @returns {Object} - the (possibly modified) context
   */
  async runHook(hookName, context = {}) {
    const handlers = this._hooks.get(hookName);
    if (!handlers || handlers.length === 0) return context;

    for (const { plugin, handler } of handlers) {
      try {
        const result = await handler(context);
        // Handler can return modified context or void
        if (result && typeof result === 'object') {
          Object.assign(context, result);
        }
      } catch (err) {
        context.errors = context.errors || [];
        context.errors.push(`Plugin "${plugin}" hook "${hookName}" error: ${err.message}`);
      }
    }

    return context;
  }

  /**
   * Get list of registered plugin names
   */
  names() {
    return Array.from(this._plugins.keys());
  }

  /**
   * Get a plugin by name
   */
  get(name) {
    return this._plugins.get(name);
  }

  /**
   * Check if a hook has any handlers
   */
  hasHandlers(hookName) {
    const handlers = this._hooks.get(hookName);
    return handlers && handlers.length > 0;
  }
}

// ── Built-in plugins ──

/**
 * ContextInject plugin — adds extra context to system prompt
 */
export function createContextPlugin(contextText) {
  return {
    name: 'context-inject',
    hooks: {
      before_prompt_build: (ctx) => {
        ctx.extraContext = ctx.extraContext || [];
        ctx.extraContext.push(contextText);
        return ctx;
      },
    },
  };
}

/**
 * UsageLogger plugin — logs token usage after each run
 */
export function createUsageLoggerPlugin(logger) {
  return {
    name: 'usage-logger',
    hooks: {
      agent_end: (ctx) => {
        if (ctx.usage) {
          logger.info(`Tokens: ${ctx.usage.total_tokens} (prompt: ${ctx.usage.prompt_tokens}, completion: ${ctx.usage.completion_tokens})`);
        }
        return ctx;
      },
    },
  };
}
