/**
 * glob Tool - file pattern search.
 */

import fs from 'node:fs';
import path from 'node:path';
import { makeTool } from './registry.js';
import { getToolSandbox, resolveWorkspacePath, WorkspaceSandboxError } from './sandbox.js';

const MAX_RESULTS = 100;

function matchGlob(filename, pattern) {
  const normalizedFile = filename.replace(/\\/g, '/');
  const normalizedPattern = String(pattern || '').replace(/\\/g, '/');
  const regex = normalizedPattern
    .replace(/\./g, '\\.')
    .replace(/\*\*/g, '{{GLOBSTAR}}')
    .replace(/\*/g, '[^/]*')
    .replace(/\{\{GLOBSTAR\}\}/g, '.*')
    .replace(/\?/g, '[^/]');

  return new RegExp(`^${regex}$`, 'i').test(normalizedFile);
}

function walkDir(dir, pattern, workspace, maxDepth = 10, depth = 0) {
  if (depth > maxDepth) return [];

  const results = [];
  try {
    const entries = fs.readdirSync(dir, { withFileTypes: true });
    for (const entry of entries) {
      if (entry.name.startsWith('.') && !pattern.startsWith('.')) continue;
      if (entry.name === 'node_modules') continue;

      const fullPath = path.join(dir, entry.name);
      const relativePath = path.relative(workspace, fullPath).replace(/\\/g, '/');

      if (entry.isDirectory()) {
        results.push(...walkDir(fullPath, pattern, workspace, maxDepth, depth + 1));
      } else if (matchGlob(relativePath, pattern) || matchGlob(entry.name, pattern)) {
        const stat = fs.statSync(fullPath);
        results.push({
          path: relativePath,
          size: stat.size,
          mtime: stat.mtime.toISOString().slice(0, 16),
        });
      }

      if (results.length >= MAX_RESULTS) break;
    }
  } catch { /* skip unreadable dirs */ }

  return results.slice(0, MAX_RESULTS);
}

export function createGlobTool(config = {}) {
  return makeTool(
    'glob',
    'Find files matching a glob pattern (e.g. "**/*.js", "src/**/*.test.js"). Returns matching file paths with sizes.',
    {
      type: 'object',
      properties: {
        pattern: { type: 'string', description: 'Glob pattern (e.g. "**/*.js", "*.md", "src/**/index.js")' },
        path: { type: 'string', description: 'Directory to search (default: workspace)' },
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

      if (!fs.existsSync(searchPath)) {
        return 'Error: Path not found in workspace';
      }

      const results = walkDir(searchPath, args.pattern, sandbox.workspace);
      if (results.length === 0) {
        return `No files matching "${args.pattern}"`;
      }

      const lines = results.map(r => {
        const size = r.size < 1024 ? `${r.size}B` : r.size < 1024 * 1024 ? `${(r.size / 1024).toFixed(1)}KB` : `${(r.size / (1024 * 1024)).toFixed(1)}MB`;
        return `${size.padStart(8)}  ${r.mtime}  ${r.path}`;
      });

      return lines.join('\n') + (results.length >= MAX_RESULTS ? `\n... (truncated at ${MAX_RESULTS})` : '');
    }
  );
}

function sandboxError(err) {
  if (err instanceof WorkspaceSandboxError) {
    return `Error: Workspace sandbox denied path: ${err.message}`;
  }
  return `Error: ${err.message}`;
}

export const globTool = createGlobTool();
