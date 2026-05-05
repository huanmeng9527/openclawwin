const SECRET_KEY_RE = /(token|api[_-]?key|password|secret|credential)/i;
const SECRET_TEXT_RE = /\b(token|api[_-]?key|password|secret|credential)\b(\s*[:=]\s*)(["']?)[^"',\s}\]]+/gi;

export function sanitizeValue(value, options = {}) {
  const maxChars = options.maxChars || 4000;
  const debug = options.debug || false;

  if (value === null || value === undefined) return value;
  if (Buffer.isBuffer(value)) return '[binary redacted]';
  if (value instanceof Error) {
    const summary = { name: value.name, message: value.message };
    if (debug && value.stack) summary.stack = value.stack.slice(0, maxChars);
    return summary;
  }
  if (typeof value === 'string') return truncate(value, maxChars);
  if (typeof value !== 'object') return value;
  if (Array.isArray(value)) return value.slice(0, 50).map(item => sanitizeValue(item, options));

  const out = {};
  for (const [key, child] of Object.entries(value)) {
    if (SECRET_KEY_RE.test(key)) {
      out[key] = '[redacted]';
    } else {
      out[key] = sanitizeValue(child, options);
    }
  }
  return out;
}

export function summarizeForStorage(value, options = {}) {
  const sanitized = sanitizeValue(value, options);
  if (typeof sanitized === 'string') return sanitized;
  return truncate(JSON.stringify(sanitized), options.maxChars || 4000);
}

export function truncate(text, maxChars = 4000) {
  if (!text || text.length <= maxChars) return text || '';
  return `${text.slice(0, maxChars)}\n[truncated at ${maxChars} chars]`;
}

export function redactSecretText(text) {
  if (text === null || text === undefined) return text;
  return String(text).replace(SECRET_TEXT_RE, (_match, key, separator, quote) => `${key}${separator}${quote}[redacted]`);
}
