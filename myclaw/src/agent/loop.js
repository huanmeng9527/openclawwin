/**
 * Legacy AgentLoop compatibility entry.
 *
 * QueryEngine is the main runtime. This module intentionally re-exports the
 * QueryEngine-backed wrapper so old imports do not diverge into a second
 * runtime implementation.
 */

export { AgentLoop, QueryEngine, createMessage } from '../engine/index.js';
