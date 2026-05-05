/**
 * Provider Factory
 * 
 * Creates the appropriate provider based on config.type
 * 
 * Supported:
 *   - openai    → OpenAI / any OpenAI-compatible API
 *   - minimax   → MiniMax (native or OpenAI-compat mode)
 *   - xiaomi    → Xiaomi MiMo (OpenAI-compatible)
 *   - ollama    → Ollama (OpenAI-compatible, local)
 *   - custom    → Any OpenAI-compatible endpoint
 */

import { OpenAIProvider } from './openai.js';
import { MiniMaxProvider } from './minimax.js';
import { XiaomiMiMoProvider } from './xiaomi.js';

const PROVIDERS = {
  openai: OpenAIProvider,
  minimax: MiniMaxProvider,
  xiaomi: XiaomiMiMoProvider,
  ollama: OpenAIProvider,     // Ollama uses OpenAI-compatible API
  custom: OpenAIProvider,     // Custom OpenAI-compatible
};

export function createProvider(config) {
  const ProviderClass = PROVIDERS[config.type];
  if (!ProviderClass) {
    throw new Error(
      `Unknown provider type: "${config.type}". Available: ${Object.keys(PROVIDERS).join(', ')}`
    );
  }
  return new ProviderClass(config);
}

export { OpenAIProvider } from './openai.js';
export { MiniMaxProvider } from './minimax.js';
export { XiaomiMiMoProvider } from './xiaomi.js';
