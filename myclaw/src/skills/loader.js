/**
 * Skill Loader
 * 
 * Skills are directories containing:
 *   - SKILL.md (required): description + instructions injected into prompt
 *   - tools.js (optional): exported tool definitions
 * 
 * Skill discovery:
 *   1. Workspace skills: ~/.myclaw/workspace/skills/*
 *   2. Config skills: config.skills.extraPaths[]
 */

import fs from 'node:fs';
import path from 'node:path';

export class Skill {
  constructor(dir, name) {
    this.dir = dir;
    this.name = name;
    this.description = '';
    this.instructions = '';
    this.tools = [];
    this.metadata = {};
  }
}

export class SkillLoader {
  constructor(config = {}) {
    this._skills = new Map();
    this._enabled = new Set(config.skills?.enabled || []);
    this._extraPaths = config.skills?.extraPaths || [];

    // Default skill dirs
    const workspace = (config.agent?.workspace || '').replace('~', process.env.HOME || '');
    this._skillDirs = [
      path.join(workspace, 'skills'),
      ...this._extraPaths,
    ];
  }

  /**
   * Discover and load all skills
   */
  async loadAll() {
    this._skills.clear();

    for (const dir of this._skillDirs) {
      if (!fs.existsSync(dir)) continue;

      const entries = fs.readdirSync(dir, { withFileTypes: true });
      for (const entry of entries) {
        if (!entry.isDirectory()) continue;

        const skillDir = path.join(dir, entry.name);
        const skill = await this._loadSkill(skillDir, entry.name);
        if (skill) {
          this._skills.set(skill.name, skill);
        }
      }
    }

    return this;
  }

  /**
   * Load a single skill from a directory
   */
  async _loadSkill(skillDir, name) {
    const skillMdPath = path.join(skillDir, 'SKILL.md');
    if (!fs.existsSync(skillMdPath)) return null;

    const skill = new Skill(skillDir, name);

    // Parse SKILL.md
    const raw = fs.readFileSync(skillMdPath, 'utf-8');
    this._parseSkillMd(skill, raw);

    // Load optional tools.js
    const toolsPath = path.join(skillDir, 'tools.js');
    if (fs.existsSync(toolsPath)) {
      try {
        const mod = await import(toolsPath);
        skill.tools = mod.default || mod.tools || [];
      } catch {
        // tools.js is optional, skip on error
      }
    }

    return skill;
  }

  /**
   * Parse SKILL.md with front-matter support
   * Format:
   *   ---
   *   name: skill-name
   *   description: what it does
   *   ---
   *   Instructions content...
   */
  _parseSkillMd(skill, raw) {
    let content = raw;

    // Parse YAML-like front matter
    const fmMatch = content.match(/^---\n([\s\S]*?)\n---\n([\s\S]*)$/);
    if (fmMatch) {
      const fm = fmMatch[1];
      content = fmMatch[2];

      // Simple key: value parsing
      for (const line of fm.split('\n')) {
        const m = line.match(/^(\w+):\s*(.+)$/);
        if (m) {
          const [, key, value] = m;
          if (key === 'description') skill.description = value.trim();
          if (key === 'name') skill.name = value.trim();
          skill.metadata[key] = value.trim();
        }
      }
    }

    skill.instructions = content.trim();

    // Fallback description from first line
    if (!skill.description) {
      const firstLine = content.split('\n').find(l => l.trim() && !l.startsWith('#'));
      skill.description = (firstLine || '').trim().slice(0, 100);
    }
  }

  /**
   * Get all loaded skills
   */
  all() {
    return Array.from(this._skills.values());
  }

  /**
   * Get enabled skills (intersection of loaded + config enabled)
   * If no enabled list is set, all skills are enabled
   */
  getEnabled() {
    const all = this.all();
    if (this._enabled.size === 0) return all;
    return all.filter(s => this._enabled.has(s.name));
  }

  /**
   * Get a skill by name
   */
  get(name) {
    return this._skills.get(name);
  }

  /**
   * Build skill prompt injection
   */
  buildPrompt() {
    const skills = this.getEnabled();
    if (skills.length === 0) return '';

    const parts = ['## Available Skills\n'];

    for (const skill of skills) {
      parts.push(`### ${skill.name}`);
      if (skill.description) {
        parts.push(`> ${skill.description}`);
      }
      if (skill.instructions) {
        parts.push(skill.instructions);
      }
      parts.push('');
    }

    return parts.join('\n');
  }

  /**
   * Get all tools from enabled skills
   */
  getTools() {
    const tools = [];
    for (const skill of this.getEnabled()) {
      tools.push(...skill.tools);
    }
    return tools;
  }
}
