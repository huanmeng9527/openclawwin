import fs from 'node:fs';
import path from 'node:path';
import { MemoryRecord, MemorySearchResult, nowIso } from './models.js';
import { MemoryStore, matchesFilters, normalizeQuery, scoreRecord, sortSearchItems } from './stores.js';
import { atomicWriteText } from '../storage/index.js';

const BLOCK_RE = /<!-- memory:([A-Za-z0-9_.:-]+)\n([\s\S]*?)\n-->\n([\s\S]*?)\n<!-- \/memory:\1 -->/g;

const SEMANTIC_FILES = {
  facts: 'facts.md',
  preferences: 'preferences.md',
  project_notes: 'project_notes.md',
  decisions: 'decisions.md',
};

const PROCEDURAL_FILES = {
  skills: 'skills.md',
  tool_recipes: 'tool_recipes.md',
  policies: 'policies.md',
  runbooks: 'runbooks.md',
};

export class MarkdownStore extends MemoryStore {
  constructor(rootDir, layer) {
    super();
    if (!['semantic', 'procedural'].includes(layer)) {
      throw new Error(`MarkdownStore only supports semantic/procedural, got ${layer}`);
    }
    this.rootDir = rootDir;
    this.layer = layer;
    this.layerDir = path.join(rootDir, layer);
    fs.mkdirSync(this.layerDir, { recursive: true });
    this._ensureFiles();
  }

  put(record) {
    const next = record instanceof MemoryRecord ? record : new MemoryRecord(record);
    next.updated_at = nowIso();
    next.source = this._relativePath(this._pathFor(next));
    if (record.source && record.source !== next.source) {
      next.metadata = { ...next.metadata, provenance: record.source };
    }

    const filePath = this._pathFor(next);
    const block = formatBlock(next);
    const existing = fs.existsSync(filePath) ? fs.readFileSync(filePath, 'utf-8') : `# ${title(filePath)}\n\n`;
    const updated = replaceBlock(existing, next.id, block);
    atomicWriteText(filePath, updated);
    return next;
  }

  get(id) {
    return this.list({}, 100000).find(record => record.id === id) || null;
  }

  search(query, filters = {}, limit = 10) {
    const tokens = normalizeQuery(query);
    return this.list(filters, 100000)
      .map(record => ({ record, score: scoreRecord(record, tokens), source: record.source }))
      .filter(item => tokens.length === 0 || item.score > 0)
      .sort(sortSearchItems)
      .slice(0, limit)
      .map(item => new MemorySearchResult({
        ...item,
        reason: tokens.length ? 'markdown keyword match' : 'markdown list',
      }));
  }

  delete(id) {
    for (const file of this._files()) {
      const text = fs.readFileSync(file, 'utf-8');
      const next = removeBlock(text, id);
      if (next !== text) {
        atomicWriteText(file, next);
        return true;
      }
    }
    return false;
  }

  list(filters = {}, limit = 100) {
    const records = [];
    for (const file of this._files()) {
      for (const record of parseBlocks(file)) {
        if (matchesFilters(record, filters)) records.push(record);
      }
    }
    return records
      .sort((a, b) => b.updated_at.localeCompare(a.updated_at))
      .slice(0, limit);
  }

  clear(filters = {}) {
    const records = this.list(filters, 100000);
    for (const record of records) this.delete(record.id);
    return records.length;
  }

  _pathFor(record) {
    const category = record.metadata?.category || defaultCategory(record);
    const files = this.layer === 'semantic' ? SEMANTIC_FILES : PROCEDURAL_FILES;
    return path.join(this.layerDir, files[category] || Object.values(files)[0]);
  }

  _ensureFiles() {
    const files = this.layer === 'semantic' ? SEMANTIC_FILES : PROCEDURAL_FILES;
    for (const [name, file] of Object.entries(files)) {
      const filePath = path.join(this.layerDir, file);
      if (!fs.existsSync(filePath)) {
        atomicWriteText(filePath, `# ${name.replace(/_/g, ' ')}\n\n`);
      }
    }
  }

  _files() {
    return fs.readdirSync(this.layerDir)
      .filter(file => file.endsWith('.md'))
      .map(file => path.join(this.layerDir, file));
  }

  _relativePath(filePath) {
    return path.relative(this.rootDir, filePath).replace(/\\/g, '/');
  }
}

export function parseBlocks(filePath) {
  const text = fs.readFileSync(filePath, 'utf-8');
  const records = [];
  for (const match of text.matchAll(BLOCK_RE)) {
    try {
      const meta = JSON.parse(match[2]);
      records.push(new MemoryRecord({ ...meta, content: match[3].trim() }));
    } catch {
      // skip malformed blocks
    }
  }
  return records;
}

export function formatBlock(record) {
  const data = record.toJSON();
  const content = data.content;
  delete data.content;
  return `<!-- memory:${record.id}\n${JSON.stringify(data, null, 2)}\n-->\n${content}\n<!-- /memory:${record.id} -->`;
}

function replaceBlock(text, id, block) {
  const re = new RegExp(`<!-- memory:${escapeRe(id)}\\n[\\s\\S]*?\\n-->\\n[\\s\\S]*?\\n<!-- \\/memory:${escapeRe(id)} -->`);
  if (re.test(text)) return text.replace(re, block);
  return `${text.trimEnd()}\n\n${block}\n`;
}

function removeBlock(text, id) {
  const re = new RegExp(`\\n?<!-- memory:${escapeRe(id)}\\n[\\s\\S]*?\\n-->\\n[\\s\\S]*?\\n<!-- \\/memory:${escapeRe(id)} -->\\n?`);
  return text.replace(re, '\n');
}

function escapeRe(text) {
  return String(text).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function defaultCategory(record) {
  const tags = new Set(record.tags || []);
  if (record.layer === 'procedural') {
    for (const key of Object.keys(PROCEDURAL_FILES)) if (tags.has(key)) return key;
    return 'runbooks';
  }
  for (const key of Object.keys(SEMANTIC_FILES)) if (tags.has(key)) return key;
  return 'facts';
}

function title(filePath) {
  return path.basename(filePath, '.md').replace(/_/g, ' ');
}
