/**
 * Provider Error Handling & Retry
 * 
 * Categorizes errors and provides retry logic with exponential backoff.
 */

export class ProviderError extends Error {
  constructor(message, category, statusCode, retryable) {
    super(message);
    this.name = 'ProviderError';
    this.category = category;
    this.statusCode = statusCode;
    this.retryable = retryable;
  }
}

/**
 * Categorize an error from a provider API call
 */
export function categorizeError(err, statusCode) {
  const msg = err.message || String(err);

  // Rate limit
  if (statusCode === 429 || msg.includes('rate_limit') || msg.includes('too many requests')) {
    return new ProviderError(msg, 'rate_limit', 429, true);
  }

  // Auth errors
  if (statusCode === 401 || statusCode === 403 || msg.includes('invalid api key') || msg.includes('unauthorized')) {
    return new ProviderError(msg, 'auth', statusCode, false);
  }

  // Server errors (retryable)
  if (statusCode >= 500 || msg.includes('server error') || msg.includes('internal error')) {
    return new ProviderError(msg, 'server_error', statusCode, true);
  }

  // Timeout
  if (msg.includes('timeout') || msg.includes('ETIMEDOUT') || msg.includes('abort')) {
    return new ProviderError(msg, 'timeout', null, true);
  }

  // Network errors
  if (msg.includes('ECONNREFUSED') || msg.includes('ENOTFOUND') || msg.includes('ECONNRESET') || msg.includes('fetch failed')) {
    return new ProviderError(msg, 'network', null, true);
  }

  // Context length
  if (msg.includes('context_length') || msg.includes('too long') || msg.includes('max_tokens')) {
    return new ProviderError(msg, 'context_length', null, false);
  }

  // Content filter
  if (msg.includes('content_filter') || msg.includes('safety') || msg.includes('blocked')) {
    return new ProviderError(msg, 'content_filter', null, false);
  }

  // Unknown
  return new ProviderError(msg, 'unknown', statusCode, false);
}

/**
 * Retry wrapper with exponential backoff
 * 
 * @param {Function} fn - async function to retry
 * @param {Object} options
 * @param {number} options.maxRetries - max retry attempts (default: 3)
 * @param {number} options.baseDelay - base delay in ms (default: 1000)
 * @param {number} options.maxDelay - max delay in ms (default: 30000)
 * @returns {Promise<*>}
 */
export async function withRetry(fn, options = {}) {
  const { maxRetries = 3, baseDelay = 1000, maxDelay = 30000 } = options;

  let lastError;
  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    try {
      return await fn();
    } catch (err) {
      const categorized = err instanceof ProviderError ? err : categorizeError(err);

      if (!categorized.retryable || attempt >= maxRetries) {
        throw categorized;
      }

      lastError = categorized;

      // Extract Retry-After header if available
      const retryAfter = err.retryAfter || null;
      let delay;
      if (retryAfter) {
        delay = parseInt(retryAfter, 10) * 1000;
      } else {
        delay = Math.min(baseDelay * Math.pow(2, attempt) + Math.random() * 1000, maxDelay);
      }

      await new Promise(r => setTimeout(r, delay));
    }
  }

  throw lastError;
}
