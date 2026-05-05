/**
 * Streaming — Stream model responses token by token
 * 
 * Supports:
 *   - OpenAI SSE streaming (stream: true)
 *   - Console output with typing effect
 *   - Accumulated text collection
 */

/**
 * Stream handler for OpenAI SSE responses
 * Parses event stream and emits tokens via callback
 */
export class StreamHandler {
  constructor(onToken, onDone) {
    this._onToken = onToken || (() => {});
    this._onDone = onDone || (() => {});
    this._buffer = '';
    this._text = '';
    this._toolCalls = [];
    this._finished = false;
  }

  /**
   * Process a chunk of SSE data
   */
  processChunk(chunk) {
    this._buffer += chunk;

    // Split by double newline (SSE event boundary)
    const events = this._buffer.split('\n\n');
    this._buffer = events.pop() || ''; // keep incomplete

    for (const event of events) {
      this._processEvent(event.trim());
    }
  }

  _processEvent(event) {
    if (!event) return;

    // Parse SSE lines
    const lines = event.split('\n');
    let data = '';

    for (const line of lines) {
      if (line.startsWith('data: ')) {
        data = line.slice(6);
      }
    }

    if (!data || data === '[DONE]') {
      if (data === '[DONE]' && !this._finished) {
        this._finished = true;
        this._onDone({
          text: this._text,
          toolCalls: this._toolCalls,
        });
      }
      return;
    }

    try {
      const parsed = JSON.parse(data);
      const delta = parsed.choices?.[0]?.delta;

      if (!delta) return;

      // Text content
      if (delta.content) {
        this._text += delta.content;
        this._onToken(delta.content, 'text');
      }

      // Tool calls (streamed incrementally)
      if (delta.tool_calls) {
        for (const tc of delta.tool_calls) {
          const idx = tc.index || 0;
          if (!this._toolCalls[idx]) {
            this._toolCalls[idx] = {
              id: tc.id || '',
              type: 'function',
              function: { name: '', arguments: '' },
            };
          }
          if (tc.id) this._toolCalls[idx].id = tc.id;
          if (tc.function?.name) this._toolCalls[idx].function.name += tc.function.name;
          if (tc.function?.arguments) this._toolCalls[idx].function.arguments += tc.function.arguments;
        }
      }

      // Finish reason
      const finishReason = parsed.choices?.[0]?.finish_reason;
      if (finishReason === 'stop' && !this._finished) {
        this._finished = true;
        this._onDone({ text: this._text, toolCalls: this._toolCalls });
      }
      if (finishReason === 'tool_calls' && !this._finished) {
        this._finished = true;
        this._onDone({ text: this._text, toolCalls: this._toolCalls });
      }
    } catch {
      // skip unparseable events
    }
  }

  get text() { return this._text; }
  get toolCalls() { return this._toolCalls; }
  get finished() { return this._finished; }
}

/**
 * Stream a chat completion from an OpenAI-compatible API
 * @param {Object} provider - OpenAIProvider instance
 * @param {Object} params - { messages, tools, model }
 * @param {Object} callbacks - { onToken, onDone, onError }
 * @returns {Promise<{ text: string, toolCalls: Array }>}
 */
export async function streamChat(provider, params, callbacks = {}) {
  const { onToken, onDone, onError } = callbacks;

  const url = `${provider.baseUrl}/chat/completions`;
  const body = {
    model: params.model || provider.model,
    messages: params.messages,
    temperature: provider.temperature,
    max_tokens: provider.maxTokens,
    stream: true,
  };

  if (params.tools && params.tools.length > 0) {
    body.tools = params.tools;
    body.tool_choice = 'auto';
  }

  const headers = { 'Content-Type': 'application/json' };
  if (provider.apiKey) {
    headers['Authorization'] = `Bearer ${provider.apiKey}`;
  }

  const response = await fetch(url, {
    method: 'POST',
    headers,
    body: JSON.stringify(body),
  });

  if (!response.ok) {
    const text = await response.text().catch(() => '');
    throw new Error(`Provider error ${response.status}: ${text || response.statusText}`);
  }

  const handler = new StreamHandler(onToken, onDone);

  // Process the stream
  const reader = response.body.getReader();
  const decoder = new TextDecoder();

  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;

      const chunk = decoder.decode(value, { stream: true });
      handler.processChunk(chunk);
    }
  } catch (err) {
    if (onError) onError(err);
    else throw err;
  }

  // Final flush
  if (!handler.finished) {
    handler.processChunk('\n\n');
    if (!handler.finished) {
      handler._finished = true;
      handler._onDone({
        text: handler.text,
        toolCalls: handler.toolCalls,
      });
    }
  }

  return {
    text: handler.text,
    toolCalls: handler.toolCalls,
  };
}

/**
 * Console stream output — prints tokens with typing effect
 */
export function createConsoleStreamer(prefix = '') {
  let charCount = 0;

  return {
    onToken(token) {
      process.stdout.write(token);
      charCount += token.length;
    },
    onDone({ text }) {
      if (charCount > 0) {
        process.stdout.write('\n');
      }
      charCount = 0;
    },
  };
}
