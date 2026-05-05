import { makeTool } from '../tools/registry.js';
import { MemoryRecord } from './models.js';

export function createMemoryTools(memoryRouter, defaultContext = {}) {
  return [
    makeTool('memory.search', 'Search four-layer memory.', {
      type: 'object',
      properties: {
        query: { type: 'string' },
        layers: { type: 'array', items: { type: 'string' } },
        limit: { type: 'number' },
      },
      required: ['query'],
    }, async (args) => {
      const results = memoryRouter.retrieve(args.query, { ...defaultContext, ...(args.context || {}) }, {
        layers: args.layers,
        limit: args.limit || 10,
        budgetChars: args.budgetChars,
      });
      return JSON.stringify(results.map(result => result.toJSON()));
    }),
    makeTool('memory.write', 'Write to memory through policy gate.', {
      type: 'object',
      properties: {
        layer: { type: 'string' },
        content: { type: 'string' },
      },
      required: ['layer', 'content'],
    }, async (args) => {
      const record = new MemoryRecord({
        ...args,
        layer: args.layer,
        source: args.source || 'tool:memory.write',
      });
      const saved = memoryRouter.write(record, args.layer, { ...defaultContext, ...(args.context || {}) });
      return JSON.stringify(saved.toJSON());
    }),
    makeTool('memory.delete', 'Delete a memory record.', {
      type: 'object',
      properties: { id: { type: 'string' } },
      required: ['id'],
    }, async (args) => {
      return JSON.stringify({ deleted: memoryRouter.delete(args.id, { ...defaultContext, ...(args.context || {}) }) });
    }),
    makeTool('memory.reindex', 'Reindex Markdown memory.', {
      type: 'object',
      properties: { layer: { type: 'string' } },
    }, async (args) => {
      return JSON.stringify(memoryRouter.reindex(args.layer || null, { ...defaultContext, ...(args.context || {}) }));
    }),
    makeTool('memory.summarize_session', 'Summarize L2 session memory.', {
      type: 'object',
      properties: { session_id: { type: 'string' }, limit: { type: 'number' } },
      required: ['session_id'],
    }, async (args) => {
      return memoryRouter.session.summarizeSession(args.session_id, args.limit || 50);
    }),
  ];
}
