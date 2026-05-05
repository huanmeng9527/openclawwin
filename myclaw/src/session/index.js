/**
 * Session Manager
 * 
 * Manages conversation sessions as JSON files.
 * Each session: { id, name, created, updated, messages[], metadata }
 * 
 * Storage: ~/.myclaw/sessions/<id>.json
 */

import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import crypto from 'node:crypto';
import { atomicWriteJson, readJsonSafe } from '../storage/index.js';

function getSessionsDir() {
  const home = process.env.MYCLAW_HOME || path.join(os.homedir(), '.myclaw');
  return path.join(home, 'sessions');
}

function genId() {
  return crypto.randomBytes(6).toString('hex');
}

export class Session {
  constructor(data) {
    this.id = data.id;
    this.name = data.name || '';
    this.created = data.created || new Date().toISOString();
    this.updated = data.updated || new Date().toISOString();
    this.messages = data.messages || [];
    this.metadata = data.metadata || {};
  }

  /** Add a message to the session */
  addMessage(role, content, extra = {}) {
    const msg = {
      role,
      content,
      timestamp: new Date().toISOString(),
      ...extra,
    };
    this.messages.push(msg);
    this.updated = new Date().toISOString();
    return msg;
  }

  /** Get messages in OpenAI format (strips internal fields) */
  toMessages() {
    return this.messages.map(m => {
      const out = { role: m.role, content: m.content };
      if (m.tool_call_id) out.tool_call_id = m.tool_call_id;
      if (m.tool_calls) out.tool_calls = m.tool_calls;
      return out;
    });
  }

  /** Get message count */
  get length() {
    return this.messages.length;
  }

  /** Get a summary of the session */
  get summary() {
    const userMsgs = this.messages.filter(m => m.role === 'user').length;
    const toolMsgs = this.messages.filter(m => m.role === 'tool').length;
    const firstUser = this.messages.find(m => m.role === 'user');
    return {
      id: this.id,
      name: this.name,
      created: this.created,
      updated: this.updated,
      messages: this.messages.length,
      userMessages: userMsgs,
      toolCalls: toolMsgs,
      preview: firstUser?.content?.slice(0, 80) || '(empty)',
    };
  }

  /** Serialize to JSON */
  toJSON() {
    return {
      id: this.id,
      name: this.name,
      created: this.created,
      updated: this.updated,
      messages: this.messages,
      metadata: this.metadata,
    };
  }
}

export class SessionManager {
  constructor(sessionsDir) {
    this._dir = sessionsDir || getSessionsDir();
    this._ensureDir();
  }

  _ensureDir() {
    if (!fs.existsSync(this._dir)) {
      fs.mkdirSync(this._dir, { recursive: true });
    }
  }

  /** Create a new session */
  create(name = '') {
    const id = genId();
    const session = new Session({ id, name });
    this._save(session);
    return session;
  }

  /** Load a session by ID */
  load(id) {
    const filePath = this._path(id);
    if (!fs.existsSync(filePath)) {
      throw new Error(`Session not found: ${id}`);
    }
    const data = readJsonSafe(filePath, null);
    if (!data) throw new Error(`Session not found or corrupt: ${id}`);
    return new Session(data);
  }

  /** Save a session */
  _save(session) {
    const filePath = this._path(session.id);
    atomicWriteJson(filePath, session.toJSON());
  }

  /** Save an existing session */
  save(session) {
    this._save(session);
    return session;
  }

  /** Delete a session */
  delete(id) {
    const filePath = this._path(id);
    if (fs.existsSync(filePath)) {
      fs.unlinkSync(filePath);
      return true;
    }
    return false;
  }

  /** List all sessions (sorted by updated desc) */
  list() {
    this._ensureDir();
    const files = fs.readdirSync(this._dir).filter(f => f.endsWith('.json'));

    const sessions = [];
    for (const file of files) {
      const data = readJsonSafe(path.join(this._dir, file), null);
      if (data) sessions.push(new Session(data));
    }

    return sessions
      .sort((a, b) => new Date(b.updated) - new Date(a.updated))
      .map(s => s.summary);
  }

  /** Find sessions by name or preview text */
  search(query) {
    const q = query.toLowerCase();
    return this.list().filter(s =>
      s.name.toLowerCase().includes(q) ||
      s.preview.toLowerCase().includes(q)
    );
  }

  /** Get the most recent session (or null) */
  latest() {
    const list = this.list();
    if (list.length === 0) return null;
    return this.load(list[0].id);
  }

  /** Prune old sessions, keeping the N most recent */
  prune(keep = 10) {
    const list = this.list();
    const toDelete = list.slice(keep);
    for (const s of toDelete) {
      this.delete(s.id);
    }
    return toDelete.length;
  }

  /** Get session file path */
  _path(id) {
    return path.join(this._dir, `${id}.json`);
  }

  /** Get sessions directory */
  get dir() {
    return this._dir;
  }

  /** Export a session as JSON string */
  exportSession(id) {
    const session = this.load(id);
    return JSON.stringify(session.toJSON(), null, 2);
  }

  /** Import a session from JSON string */
  importSession(jsonStr) {
    const data = JSON.parse(jsonStr);
    if (!data.id) throw new Error('Invalid session data: missing id');
    // Create new ID to avoid conflicts
    data.id = genId();
    data.imported = new Date().toISOString();
    const session = new Session(data);
    this._save(session);
    return session;
  }

  /** Export all sessions as JSON array */
  exportAll() {
    const all = [];
    for (const summary of this.list()) {
      try {
        all.push(this.load(summary.id).toJSON());
      } catch { /* skip corrupt */ }
    }
    return JSON.stringify(all, null, 2);
  }
}

export { SessionTranscriptRecorder } from './transcript.js';
