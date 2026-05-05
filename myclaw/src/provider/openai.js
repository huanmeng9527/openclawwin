/**
 * OpenAI-compatible Provider Adapter
 * 
 * Supports any OpenAI-compatible API (OpenAI, Ollama, vLLM, etc.)
 * With retry logic and error categorization.
 */

import { withRetry, categorizeError } from './errors.js';

export class OpenAIProvider {
  constructor(config) {
    this.baseUrl = (config.baseUrl || 'https://api.openai.com/v1').replace(/\/+$/, '');
    this.apiKey = config.apiKey || process.env.MYCLAW_API_KEY || process.env.OPENAI_API_KEY || '';
    this.model = config.model || 'gpt-4o-mini';
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

      if (tools && tools.length > 0) {
        body.tools = tools;
        body.tool_choice = 'auto';
      }

      const response = await fetch(`${this.baseUrl}/chat/completions`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          ...(this.apiKey ? { 'Authorization': `Bearer ${this.apiKey}` } : {}),
        },
        body: JSON.stringify(body),
      });

      if (!response.ok) {
        const text = await response.text().catch(() => '');
        const err = categorizeError(new Error(text || response.statusText), response.status);

        // Extract retry-after
        const retryAfter = response.headers?.get?.('retry-after');
        if (retryAfter) err.retryAfter = retryAfter;

        throw err;
      }

      return response.json();
    });
  }

  static extractMessage(response) {
    return response.choices?.[0]?.message || null;
  }

  static extractUsage(response) {
    return response.usage || null;
  }
}
