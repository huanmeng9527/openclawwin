import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

export class WorkspaceSandboxError extends Error {
  constructor(message) {
    super(message);
    this.name = 'WorkspaceSandboxError';
  }
}

export function resolveWorkspacePath(inputPath = '.', workspace = process.cwd(), options = {}) {
  const workspacePath = normalizeWorkspace(workspace);
  const allowExternalPaths = options.allowExternalPaths === true;
  const rejectSymlinkEscape = options.rejectSymlinkEscape !== false;
  const rawInput = String(inputPath || '.');
  const resolvedPath = path.isAbsolute(rawInput)
    ? path.resolve(rawInput)
    : path.resolve(workspacePath, rawInput);

  if (!allowExternalPaths) {
    assertInsideWorkspace(resolvedPath, workspacePath);
  }

  if (!allowExternalPaths && rejectSymlinkEscape) {
    const realTarget = realPathForSandbox(resolvedPath);
    assertInsideWorkspace(realTarget, workspacePath);
  }

  return resolvedPath;
}

export function assertInsideWorkspace(resolvedPath, workspace) {
  const workspacePath = normalizeWorkspace(workspace);
  const targetPath = path.resolve(expandHome(String(resolvedPath || '')));
  const relative = path.relative(workspacePath, targetPath);
  const normalizedRelative = process.platform === 'win32' ? relative.toLowerCase() : relative;

  if (normalizedRelative === '' || (!normalizedRelative.startsWith('..') && !path.isAbsolute(normalizedRelative))) {
    return targetPath;
  }

  throw new WorkspaceSandboxError(
    'Path is outside the configured workspace. Use a path inside agent.workspace or enable tools.allowExternalPaths.'
  );
}

export function getToolSandbox(config = {}) {
  const workspace = config.agent?.workspace || process.cwd();
  return {
    workspace: normalizeWorkspace(workspace),
    allowExternalPaths: config.tools?.allowExternalPaths === true,
  };
}

export function safeDisplayPath(targetPath, workspace) {
  const workspacePath = normalizeWorkspace(workspace);
  try {
    assertInsideWorkspace(targetPath, workspacePath);
    const relative = path.relative(workspacePath, path.resolve(targetPath));
    return relative || '.';
  } catch {
    return '[outside workspace]';
  }
}

function normalizeWorkspace(workspace) {
  return path.resolve(expandHome(String(workspace || process.cwd())));
}

function expandHome(value) {
  if (!value.startsWith('~')) return value;
  const home = os.homedir();
  if (value === '~') return home;
  if (value.startsWith(`~${path.sep}`) || value.startsWith('~/')) {
    return path.join(home, value.slice(2));
  }
  return value;
}

function realPathForSandbox(targetPath) {
  let current = path.resolve(targetPath);
  const missingSegments = [];

  while (!fs.existsSync(current)) {
    const parent = path.dirname(current);
    if (parent === current) break;
    missingSegments.unshift(path.basename(current));
    current = parent;
  }

  const realCurrent = fs.existsSync(current) ? fs.realpathSync(current) : current;
  return missingSegments.length > 0 ? path.join(realCurrent, ...missingSegments) : realCurrent;
}
