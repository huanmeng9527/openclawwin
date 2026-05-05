/**
 * Engine module — QueryEngine (new) + AgentLoop (legacy compat)
 */

export { QueryEngine, createMessage } from './query.js';

// Legacy compat: AgentLoop wraps QueryEngine with the old API
import { QueryEngine } from './query.js';

export class AgentLoop {
  constructor(config) {
    this._engine = new QueryEngine(config);
  }

  async init() {
    await this._engine.init();
    return this;
  }

  async run(userMessage, session, options = {}) {
    return this._engine.run(userMessage, session, options);
  }

  getToolNames() { return this._engine.getToolNames(); }
  get sessions() { return this._engine.sessions; }
  get skills() { return this._engine.skills; }
  get plugins() { return this._engine.plugins; }

  async buildSystemPrompt(session) {
    return this._engine.fetchSystemPromptParts(session);
  }
}
