/**
 * Xiaomi MiMo Provider Adapter
 * With retry logic and error categorization.
 */

import { withRetry, categorizeError } from './errors.js';

export class XiaomiMiMoProvider {
  constructor(config) {
    this.baseUrl = (config.baseUrl || 'https://api.xiaomimimo.com/v1').replace(/\/+$/, '');
    this.apiKey = config.apiKey || process.env.MIMO_API_KEY || process.env.XIAOMI_API_KEY || '';
    this.model = config.model || 'mimo-v2-pro';
    this.temperature = config.temperature ?? 0.7;
    this.maxTokens = config.maxTokens || 4096;
  }

  async chat({ messages, tools, model }) {
    return withRetry(async () => {
      const body = {
        model: model || this.model,
        messages,
        temperature: this.temperature,
        max_tokens: this.maxTokens,
      };
      if (tools?.length > 0) { body.tools = tools; body.tool_choice = 'auto'; }

      const response = await fetch(`${this.baseUrl}/chat/completions`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${this.apiKey}`,
        },
        body: JSON.stringify(body),
      });

      if (!response.ok) {
        const text = await response.text().catch(() => '');
        throw categorizeError(new Error(text || response.statusText), response.status);
      }
      return response.json();
    });
  }
}
