/**
 * Config Manager
 * 
 * Handles loading, saving, validating, and merging config.
 * Config lives at ~/.myclaw/myclaw.json (or MYCLAW_HOME env).
 */

import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { DEFAULTS, SCHEMA, CONFIG_VERSION } from './schema.js';

// ── Resolve config directory ──
function getConfigDir() {
  const home = process.env.MYCLAW_HOME || path.join(os.homedir(), '.myclaw');
  return path.resolve(home);
}

function getConfigPath() {
  return path.join(getConfigDir(), 'myclaw.json');
}

export function getDefaultWorkspace() {
  if (process.env.MYCLAW_HOME) {
    return path.join(getConfigDir(), 'workspace');
  }
  return '~/.myclaw/workspace';
}

export function getRuntimeDefaults() {
  const defaults = structuredClone(DEFAULTS);
  defaults.agent.workspace = getDefaultWorkspace();
  return defaults;
}

// ── Deep merge (source wins over target) ──
function deepMerge(target, source) {
  const result = { ...target };
  for (const key of Object.keys(source)) {
    if (
      source[key] && typeof source[key] === 'object' && !Array.isArray(source[key]) &&
      target[key] && typeof target[key] === 'object' && !Array.isArray(target[key])
    ) {
      result[key] = deepMerge(target[key], source[key]);
    } else if (source[key] !== undefined && source[key] !== '') {
      result[key] = source[key];
    }
  }
  return result;
}

// ── Get nested value by dot-path ──
function getByPath(obj, dotPath) {
  return dotPath.split('.').reduce((o, k) => (o && o[k] !== undefined ? o[k] : undefined), obj);
}

// ── Set nested value by dot-path ──
function setByPath(obj, dotPath, value) {
  const keys = dotPath.split('.');
  let cur = obj;
  for (let i = 0; i < keys.length - 1; i++) {
    if (!cur[keys[i]] || typeof cur[keys[i]] !== 'object') {
      cur[keys[i]] = {};
    }
    cur = cur[keys[i]];
  }
  cur[keys[keys.length - 1]] = value;
  return obj;
}

// ── Validate config against schema ──
function validate(config) {
  const errors = [];

  for (const [field, rule] of Object.entries(SCHEMA)) {
    const value = getByPath(config, field);

    // Required check
    if (rule.required && (value === undefined || value === null || value === '')) {
      errors.push(`Missing required field: ${field}`);
      continue;
    }

    if (value === undefined || value === null) continue;

    // Type check
    if (rule.type === 'array') {
      if (!Array.isArray(value)) {
        errors.push(`${field}: expected array, got ${typeof value}`);
        continue;
      }
    } else if (typeof value !== rule.type) {
      errors.push(`${field}: expected ${rule.type}, got ${typeof value}`);
      continue;
    }

    // Enum check
    if (rule.enum && !rule.enum.includes(value)) {
      errors.push(`${field}: must be one of [${rule.enum.join(', ')}], got "${value}"`);
    }

    // Custom validator
    if (rule.validate && !rule.validate(value)) {
      errors.push(`${field}: validation failed for value "${value}"`);
    }
  }

  return errors;
}

// ── Config class ──
export class Config {
  constructor(configPath) {
    this._path = configPath || getConfigPath();
    this._data = null;
    this._dirty = false;
  }

  /** Load config from disk, merge with defaults */
  load() {
    let fileData = {};

    if (fs.existsSync(this._path)) {
      try {
        const raw = fs.readFileSync(this._path, 'utf-8');
        fileData = JSON.parse(raw);
      } catch (err) {
        throw new Error(`Failed to parse config at ${this._path}: ${err.message}`);
      }
    }

    // Deep merge: defaults ← file data
    this._data = deepMerge(getRuntimeDefaults(), fileData);
    this._dirty = false;
    return this;
  }

  /** Save config to disk */
  save() {
    if (!this._data) throw new Error('Config not loaded');

    const dir = path.dirname(this._path);
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
    }

    fs.writeFileSync(this._path, JSON.stringify(this._data, null, 2) + '\n', 'utf-8');
    this._dirty = false;
    return this;
  }

  /** Get value by dot-path */
  get(dotPath) {
    if (!this._data) throw new Error('Config not loaded — call load() first');
    return getByPath(this._data, dotPath);
  }

  /** Set value by dot-path */
  set(dotPath, value) {
    if (!this._data) throw new Error('Config not loaded — call load() first');
    setByPath(this._data, dotPath, value);
    this._dirty = true;
    return this;
  }

  /** Get full config data */
  all() {
    if (!this._data) throw new Error('Config not loaded — call load() first');
    return { ...this._data };
  }

  /** Validate current config */
  validate() {
    if (!this._data) throw new Error('Config not loaded — call load() first');
    return validate(this._data);
  }

  /** Check if config file exists on disk */
  static exists(configPath) {
    const p = configPath || getConfigPath();
    return fs.existsSync(p);
  }

  /** Get default config directory */
  static getConfigDir() {
    return getConfigDir();
  }

  /** Get default config file path */
  static getConfigPath() {
    return getConfigPath();
  }

  /** Create a fresh config with defaults and save it */
  static init(configPath) {
    const cfg = new Config(configPath);
    cfg._data = getRuntimeDefaults();
    cfg.save();
    return cfg;
  }

  get path() { return this._path; }
  get dirty() { return this._dirty; }
}
