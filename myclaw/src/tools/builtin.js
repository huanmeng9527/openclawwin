/**
 * Built-in Tools
 *
 * Core tools: read, write, exec, list_files.
 * File-system tools are constrained to config.agent.workspace by default.
 */

import fs from 'node:fs';
import path from 'node:path';
import { execSync } from 'node:child_process';
import { makeTool } from './registry.js';
import { evaluateExecCommandPolicy } from './permissions.js';
import { getToolSandbox, resolveWorkspacePath, safeDisplayPath, WorkspaceSandboxError } from './sandbox.js';
import { createEditTool, editTool } from './edit.js';
import { createGrepTool, grepTool } from './grep.js';
import { createGlobTool, globTool } from './glob.js';

const MAX_RESULT_CHARS = 100000;

function truncate(text, max = MAX_RESULT_CHARS) {
  if (!text || text.length <= max) return text;
  return text.slice(0, max) + `\n\n[Truncated at ${max} chars]`;
}

function sandboxOptions(config) {
  const sandbox = getToolSandbox(config);
  return {
    workspace: sandbox.workspace,
    allowExternalPaths: sandbox.allowExternalPaths,
  };
}

export function createReadTool(config = {}) {
  return makeTool(
    'read',
    'Read the contents of a file. Returns the file text.',
    {
      type: 'object',
      properties: {
        path: { type: 'string', description: 'Absolute or relative file path' },
        offset: { type: 'number', description: 'Line number to start from (1-indexed)' },
        limit: { type: 'number', description: 'Max number of lines to read' },
      },
      required: ['path'],
    },
    async (args) => {
      const sandbox = sandboxOptions(config);
      let filePath;
      try {
        filePath = resolveWorkspacePath(args.path, sandbox.workspace, sandbox);
      } catch (err) {
        return sandboxError(err);
      }

      if (!fs.existsSync(filePath)) {
        return `Error: File not found in workspace: ${safeDisplayPath(filePath, sandbox.workspace)}`;
      }
      const stat = fs.statSync(filePath);
      if (stat.isDirectory()) {
        const entries = fs.readdirSync(filePath)
          .map(e => {
            const s = fs.statSync(path.join(filePath, e));
            return s.isDirectory() ? `${e}/` : e;
          });
        return entries.join('\n');
      }
      let content = fs.readFileSync(filePath, 'utf-8');
      if (args.offset || args.limit) {
        const lines = content.split('\n');
        const start = (args.offset || 1) - 1;
        const end = args.limit ? start + args.limit : lines.length;
        content = lines.slice(start, end).join('\n');
      }
      return truncate(content);
    }
  );
}

export function createWriteTool(config = {}) {
  return makeTool(
    'write',
    'Write content to a file. Creates the file if it doesn\'t exist, overwrites if it does.',
    {
      type: 'object',
      properties: {
        path: { type: 'string', description: 'File path to write to' },
        content: { type: 'string', description: 'Content to write' },
      },
      required: ['path', 'content'],
    },
    async (args) => {
      const sandbox = sandboxOptions(config);
      let filePath;
      try {
        filePath = resolveWorkspacePath(args.path, sandbox.workspace, sandbox);
      } catch (err) {
        return sandboxError(err);
      }

      const dir = path.dirname(filePath);
      if (!fs.existsSync(dir)) {
        fs.mkdirSync(dir, { recursive: true });
      }
      fs.writeFileSync(filePath, args.content, 'utf-8');
      return `Written ${String(args.content || '').length} bytes to ${safeDisplayPath(filePath, sandbox.workspace)}`;
    }
  );
}

export function createExecTool(config = {}) {
  return makeTool(
    'exec',
    'Execute a shell command and return its stdout/stderr.',
    {
      type: 'object',
      properties: {
        command: { type: 'string', description: 'Shell command to execute' },
        timeout: { type: 'number', description: 'Timeout in seconds (default: 30)' },
        cwd: { type: 'string', description: 'Working directory, constrained to agent.workspace by default' },
      },
      required: ['command'],
    },
    async (args) => {
      const execPolicy = evaluateExecCommandPolicy(args.command, config.tools?.exec || {});
      if (!execPolicy.allowed) {
        return `Error: ${execPolicy.reason}`;
      }

      const sandbox = sandboxOptions(config);
      let cwd;
      try {
        cwd = resolveWorkspacePath(args.cwd || '.', sandbox.workspace, sandbox);
      } catch (err) {
        return sandboxError(err, 'Invalid exec cwd');
      }

      if (!fs.existsSync(cwd) || !fs.statSync(cwd).isDirectory()) {
        return `Error: Exec cwd not found in workspace: ${safeDisplayPath(cwd, sandbox.workspace)}`;
      }

      const timeout = (args.timeout || config.tools?.exec?.timeout || 30) * 1000;
      try {
        const output = execSync(args.command, {
          cwd,
          encoding: 'utf-8',
          timeout,
          maxBuffer: 1024 * 1024,
          stdio: ['pipe', 'pipe', 'pipe'],
        });
        return truncate(output || '(no output)');
      } catch (err) {
        const parts = [];
        if (err.stdout) parts.push(`stdout:\n${err.stdout}`);
        if (err.stderr) parts.push(`stderr:\n${err.stderr}`);
        parts.push(`exit code: ${err.status}`);
        return truncate(parts.join('\n'));
      }
    }
  );
}

export function createListFilesTool(config = {}) {
  return makeTool(
    'list_files',
    'List files and directories in a path with sizes. Defaults to the configured workspace.',
    {
      type: 'object',
      properties: {
        path: { type: 'string', description: 'Directory path (default: workspace)' },
        pattern: { type: 'string', description: 'Glob pattern to filter (e.g. "*.js")' },
      },
    },
    async (args) => {
      const sandbox = sandboxOptions(config);
      let dirPath;
      try {
        dirPath = resolveWorkspacePath(args.path || '.', sandbox.workspace, sandbox);
      } catch (err) {
        return sandboxError(err);
      }

      if (!fs.existsSync(dirPath)) {
        return `Error: Directory not found in workspace: ${safeDisplayPath(dirPath, sandbox.workspace)}`;
      }
      if (!fs.statSync(dirPath).isDirectory()) {
        return `Error: Not a directory in workspace: ${safeDisplayPath(dirPath, sandbox.workspace)}`;
      }

      let entries = fs.readdirSync(dirPath);
      if (args.pattern) {
        const regex = new RegExp('^' + args.pattern.replace(/\*/g, '.*').replace(/\?/g, '.') + '$', 'i');
        entries = entries.filter(e => regex.test(e));
      }

      const lines = entries.map(e => {
        const full = path.join(dirPath, e);
        try {
          const stat = fs.statSync(full);
          const size = stat.isDirectory() ? '<DIR>' : formatSize(stat.size);
          const time = stat.mtime.toISOString().slice(0, 16);
          return `${stat.isDirectory() ? 'd' : '-'}  ${size.padStart(8)}  ${time}  ${e}`;
        } catch {
          return `?  ${'?'.padStart(8)}  ${'?'.padStart(16)}  ${e}`;
        }
      });

      return lines.join('\n') || '(empty directory)';
    }
  );
}

export function createBuiltinTools(config = {}) {
  return [
    createReadTool(config),
    createWriteTool(config),
    createExecTool(config),
    createListFilesTool(config),
    createEditTool(config),
    createGrepTool(config),
    createGlobTool(config),
  ];
}

function formatSize(bytes) {
  if (bytes < 1024) return `${bytes}B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)}KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)}MB`;
}

function sandboxError(err, prefix = 'Workspace sandbox denied path') {
  if (err instanceof WorkspaceSandboxError) {
    return `Error: ${prefix}: ${err.message}`;
  }
  return `Error: ${err.message}`;
}

export const readTool = createReadTool();
export const writeTool = createWriteTool();
export const execTool = createExecTool();
export const listFilesTool = createListFilesTool();
export const BUILTIN_TOOLS = [readTool, writeTool, execTool, listFilesTool, editTool, grepTool, globTool];
