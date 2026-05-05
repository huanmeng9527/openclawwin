/**
 * MiniMax Provider Adapter
 * With retry logic and error categorization.
 */

import { withRetry, categorizeError } from './errors.js';

export class MiniMaxProvider {
  constructor(config) {
    this.baseUrl = (config.baseUrl || 'https://api.minimaxi.com').replace(/\/+$/, '');
    this.apiKey = config.apiKey || process.env.MINIMAX_API_KEY || '';
    this.model = config.model || 'MiniMax-Text-01';
    this.temperature = config.temperature ?? 0.7;
    this.maxTokens = config.maxTokens || 4096;
    this.useOpenAICompat = config.minimaxCompat ?? true;
  }

  async chat({ messages, tools, model }) {
    if (this.useOpenAICompat) {
      return this._chatOpenAI({ messages, tools, model });
    }
    return this._chatNative({ messages, tools, model });
  }

  async _chatOpenAI({ messages, tools, model }) {
    return withRetry(async () => {
      const body = {
        model: model || this.model,
        messages,
        temperature: this.temperature,
        max_tokens: this.maxTokens,
      };
      if (tools?.length > 0) { body.tools = tools; body.tool_choice = 'auto'; }

      const response = await fetch(`${this.baseUrl}/v1/chat/completions`, {
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

  async _chatNative({ messages, tools, model }) {
    return withRetry(async () => {
      const modelMessages = messages.filter(m => m.role !== 'system').map(m => ({
        sender_type: m.role === 'user' ? 'USER' : 'BOT',
        text: m.content || '',
      }));
      const systemMsg = messages.find(m => m.role === 'system');

      const body = { model: model || this.model, messages: modelMessages, temperature: this.temperature, max_tokens: this.maxTokens };
      if (systemMsg) body.system_prompt = systemMsg.content;

      const response = await fetch(`${this.baseUrl}/v1/text/chatcompletion_v2`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${this.apiKey}` },
        body: JSON.stringify(body),
      });

      if (!response.ok) {
        const text = await response.text().catch(() => '');
        throw categorizeError(new Error(text || response.statusText), response.status);
      }

      const data = await response.json();
      return {
        choices: [{ message: { role: 'assistant', content: data.reply || data.choices?.[0]?.message?.content || '' }, finish_reason: 'stop' }],
        usage: data.usage || {},
      };
    });
  }
}
