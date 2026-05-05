/**
 * edit Tool - string-replace file editing.
 */

import fs from 'node:fs';
import { makeTool } from './registry.js';
import { getToolSandbox, resolveWorkspacePath, safeDisplayPath, WorkspaceSandboxError } from './sandbox.js';

export function createEditTool(config = {}) {
  return makeTool(
    'edit',
    'Edit a file by replacing exact text. The old_string must match exactly (including whitespace). Use this for precise, surgical edits.',
    {
      type: 'object',
      properties: {
        path: { type: 'string', description: 'File path to edit' },
        old_string: { type: 'string', description: 'Exact text to find and replace (must match exactly)' },
        new_string: { type: 'string', description: 'New text to replace with' },
      },
      required: ['path', 'old_string', 'new_string'],
    },
    async (args) => {
      const sandbox = getToolSandbox(config);
      let filePath;
      try {
        filePath = resolveWorkspacePath(args.path, sandbox.workspace, sandbox);
      } catch (err) {
        return sandboxError(err);
      }

      if (!fs.existsSync(filePath)) {
        return `Error: File not found in workspace: ${safeDisplayPath(filePath, sandbox.workspace)}`;
      }

      const content = fs.readFileSync(filePath, 'utf-8');
      const { old_string, new_string } = args;

      if (!old_string) {
        return 'Error: old_string cannot be empty';
      }

      const count = content.split(old_string).length - 1;
      if (count === 0) {
        return `Error: old_string not found in ${safeDisplayPath(filePath, sandbox.workspace)}. Make sure it matches exactly.`;
      }
      if (count > 1) {
        return `Error: old_string found ${count} times in ${safeDisplayPath(filePath, sandbox.workspace)}. Must be unique.`;
      }

      const newContent = content.replace(old_string, new_string);
      fs.writeFileSync(filePath, newContent, 'utf-8');

      const linesAdded = new_string.split('\n').length - old_string.split('\n').length;
      return `Edited ${safeDisplayPath(filePath, sandbox.workspace)}: replaced ${old_string.length} chars with ${new_string.length} chars (${linesAdded >= 0 ? '+' : ''}${linesAdded} lines)`;
    }
  );
}

function sandboxError(err) {
  if (err instanceof WorkspaceSandboxError) {
    return `Error: Workspace sandbox denied path: ${err.message}`;
  }
  return `Error: ${err.message}`;
}

export const editTool = createEditTool();
