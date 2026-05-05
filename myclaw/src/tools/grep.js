/**
 * grep Tool - content search.
 */

import fs from 'node:fs';
import path from 'node:path';
import { makeTool } from './registry.js';
import { getToolSandbox, resolveWorkspacePath, safeDisplayPath, WorkspaceSandboxError } from './sandbox.js';

const MAX_RESULTS = 50;

function searchFile(filePath, pattern, isRegex, workspace) {
  try {
    const content = fs.readFileSync(filePath, 'utf-8');
    const lines = content.split('\n');
    const matches = [];

    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];
      const matched = isRegex ? pattern.test(line) : line.includes(pattern);
      if (matched) {
        matches.push({
          file: safeDisplayPath(filePath, workspace),
          line: i + 1,
          text: line.trim().slice(0, 200),
        });
      }
    }

    return matches;
  } catch {
    return [];
  }
}

function walkDir(dir, pattern, isRegex, workspace, maxDepth = 5, depth = 0) {
  if (depth > maxDepth) return [];

  const results = [];
  try {
    const entries = fs.readdirSync(dir, { withFileTypes: true });
    for (const entry of entries) {
      if (entry.name.startsWith('.') || entry.name === 'node_modules') continue;

      const fullPath = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        results.push(...walkDir(fullPath, pattern, isRegex, workspace, maxDepth, depth + 1));
      } else if (entry.isFile()) {
        const ext = path.extname(entry.name).toLowerCase();
        if (['.png', '.jpg', '.gif', '.zip', '.tar', '.gz', '.exe', '.bin', '.wasm'].includes(ext)) continue;

        results.push(...searchFile(fullPath, pattern, isRegex, workspace));
        if (results.length >= MAX_RESULTS) break;
      }
    }
  } catch { /* skip unreadable dirs */ }

  return results.slice(0, MAX_RESULTS);
}

export function createGrepTool(config = {}) {
  return makeTool(
    'grep',
    'Search file contents for a pattern (regex or plain text). Returns matching lines with file paths and line numbers.',
    {
      type: 'object',
      properties: {
        pattern: { type: 'string', description: 'Search pattern (plain text or regex)' },
        path: { type: 'string', description: 'Directory or file to search (default: workspace)' },
        regex: { type: 'boolean', description: 'Treat pattern as regex (default: false)' },
        include: { type: 'string', description: 'File extension filter (e.g. "*.js")' },
      },
      required: ['pattern'],
    },
    async (args) => {
      const sandbox = getToolSandbox(config);
      let searchPath;
      try {
        searchPath = resolveWorkspacePath(args.path || '.', sandbox.workspace, sandbox);
      } catch (err) {
        return sandboxError(err);
      }

      const isRegex = args.regex || false;
      let pattern;
      if (isRegex) {
        try {
          pattern = new RegExp(args.pattern, 'i');
        } catch (e) {
          return `Error: Invalid regex: ${e.message}`;
        }
      } else {
        pattern = args.pattern;
      }

      if (!fs.existsSync(searchPath)) {
        return `Error: Path not found in workspace: ${safeDisplayPath(searchPath, sandbox.workspace)}`;
      }

      const stat = fs.statSync(searchPath);
      let results = stat.isFile()
        ? searchFile(searchPath, pattern, isRegex, sandbox.workspace)
        : walkDir(searchPath, pattern, isRegex, sandbox.workspace);

      if (args.include) {
        const ext = args.include.startsWith('.') ? args.include : `.${args.include.replace(/^\*\./, '')}`;
        results = results.filter(r => r.file.endsWith(ext));
      }

      if (results.length === 0) {
        return `No matches found for "${args.pattern}"`;
      }

      const lines = results.map(r => `${r.file}:${r.line}: ${r.text}`);
      return lines.join('\n') + (results.length >= MAX_RESULTS ? `\n... (truncated at ${MAX_RESULTS} results)` : '');
    }
  );
}

function sandboxError(err) {
  if (err instanceof WorkspaceSandboxError) {
    return `Error: Workspace sandbox denied path: ${err.message}`;
  }
  return `Error: ${err.message}`;
}

export const grepTool = createGrepTool();
