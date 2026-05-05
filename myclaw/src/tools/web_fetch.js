/**
 * web_fetch Tool
 * 
 * Fetches a URL and returns readable content (HTML → text).
 * Uses native Node.js fetch (no external deps).
 */

import { makeTool } from './registry.js';

/** Minimal HTML → readable text converter */
function htmlToText(html) {
  let text = html;

  // Remove script, style, nav, footer, header tags and content
  text = text.replace(/<(script|style|nav|footer|header|noscript)[^>]*>[\s\S]*?<\/\1>/gi, '');

  // Remove HTML comments
  text = text.replace(/<!--[\s\S]*?-->/g, '');

  // Block elements → newlines
  text = text.replace(/<\/(div|p|h[1-6]|li|tr|blockquote|section|article|br\s*\/?)>/gi, '\n');
  text = text.replace(/<br\s*\/?>/gi, '\n');

  // Links → [text](url)
  text = text.replace(/<a[^>]+href="([^"]*)"[^>]*>([\s\S]*?)<\/a>/gi, '[$2]($1)');

  // Images → alt text
  text = text.replace(/<img[^>]+alt="([^"]*)"[^>]*>/gi, '[Image: $1]');
  text = text.replace(/<img[^>]*>/gi, '[Image]');

  // Strip remaining tags
  text = text.replace(/<[^>]+>/g, '');

  // Decode common HTML entities
  text = text.replace(/&amp;/g, '&');
  text = text.replace(/&lt;/g, '<');
  text = text.replace(/&gt;/g, '>');
  text = text.replace(/&quot;/g, '"');
  text = text.replace(/&#39;/g, "'");
  text = text.replace(/&nbsp;/g, ' ');
  text = text.replace(/&#\d+;/g, '');

  // Collapse whitespace
  text = text.replace(/[ \t]+/g, ' ');
  text = text.replace(/\n\s*\n\s*\n+/g, '\n\n');
  text = text.trim();

  return text;
}

export const webFetchTool = makeTool(
  'web_fetch',
  'Fetch a URL and return its content as readable text. Works with HTML pages (converts to text) and plain text/JSON APIs.',
  {
    type: 'object',
    properties: {
      url: { type: 'string', description: 'The URL to fetch (http or https)' },
      maxLength: { type: 'number', description: 'Max characters to return (default: 50000)' },
    },
    required: ['url'],
  },
  async (args) => {
    const { url, maxLength = 50000 } = args;

    if (!url.startsWith('http://') && !url.startsWith('https://')) {
      return 'Error: URL must start with http:// or https://';
    }

    try {
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), 15000);

      const response = await fetch(url, {
        signal: controller.signal,
        headers: {
          'User-Agent': 'myclaw/0.2.0',
          'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,text/plain,*/*;q=0.8',
        },
        redirect: 'follow',
      });

      clearTimeout(timeout);

      if (!response.ok) {
        return `Error: HTTP ${response.status} ${response.statusText}`;
      }

      const contentType = response.headers.get('content-type') || '';
      const raw = await response.text();

      let text;
      if (contentType.includes('html')) {
        text = htmlToText(raw);
      } else {
        text = raw;
      }

      if (text.length > maxLength) {
        text = text.slice(0, maxLength) + `\n\n[Truncated at ${maxLength} chars]`;
      }

      return text || '(empty response)';
    } catch (err) {
      if (err.name === 'AbortError') {
        return 'Error: Request timed out (15s)';
      }
      return `Error fetching URL: ${err.message}`;
    }
  }
);
