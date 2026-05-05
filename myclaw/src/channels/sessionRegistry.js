import crypto from 'node:crypto';
import os from 'node:os';
import path from 'node:path';
import { atomicWriteJson, readJsonSafe } from '../storage/index.js';
import { sanitizeValue } from '../memory/sanitizer.js';

export const CHANNEL_SESSION_REGISTRY_SCHEMA_VERSION = 1;

export function defaultChannelSessionRegistryPath(config = {}) {
  if (config.channels?.sessionRegistry?.path) return expandHome(config.channels.sessionRegistry.path);
  const home = process.env.MYCLAW_HOME || path.join(os.homedir(), '.myclaw');
  return path.join(home, 'channels', 'sessions.json');
}

export class ChannelSessionMapping {
  constructor(data = {}) {
    const now = new Date().toISOString();
    this.id = data.id || createMappingId();
    this.channel = data.channel || 'unknown';
    this.conversationId = data.conversationId || data.conversation_id || 'default';
    this.channelUserId = data.channelUserId || data.channel_user_id || data.userId || data.user_id || 'anonymous';
    this.userId = data.userId || data.user_id || this.channelUserId;
    this.agentId = data.agentId || data.agent_id || 'myclaw';
    this.sessionId = data.sessionId || data.session_id || null;
    this.createdAt = data.createdAt || data.created_at || now;
    this.updatedAt = data.updatedAt || data.updated_at || now;
    this.lastMessageAt = data.lastMessageAt || data.last_message_at || null;
    this.messageCount = data.messageCount || data.message_count || 0;
    this.metadata = sanitizeValue(data.metadata || {}, { maxChars: 1000 });
  }

  toJSON() {
    return { ...this };
  }
}

export class ChannelSessionRegistry {
  constructor(options = {}) {
    this.config = options.config || {};
    this.filePath = options.filePath || defaultChannelSessionRegistryPath(this.config);
    this.mappings = new Map();
    this._load();
  }

  resolveSession(internalMessage, context = {}) {
    const existing = this.getMapping(
      internalMessage.channel,
      internalMessage.conversationId,
      internalMessage.userId || internalMessage.sender || context.user_id || 'anonymous'
    );
    if (existing) return this.touchMapping(existing.id, internalMessage, context);

    const session = context.sessionManager?.create?.(`channel:${internalMessage.channel}:${internalMessage.conversationId}`);
    const mapping = new ChannelSessionMapping({
      channel: internalMessage.channel,
      conversationId: internalMessage.conversationId,
      channelUserId: internalMessage.userId || internalMessage.sender || context.user_id || 'anonymous',
      userId: internalMessage.userId || context.user_id || context.defaultUserId || 'channel-user',
      agentId: internalMessage.agentId || context.agent_id || context.defaultAgentId || 'myclaw',
      sessionId: internalMessage.sessionId || session?.id || createSyntheticSessionId(),
      lastMessageAt: internalMessage.timestamp || new Date().toISOString(),
      messageCount: 1,
      metadata: {
        source: 'channel-session-registry',
      },
    });
    return this.upsertMapping(mapping);
  }

  getMapping(channel, conversationId, userId) {
    const signature = mappingSignature({ channel, conversationId, channelUserId: userId });
    return [...this.mappings.values()].find(mapping => mappingSignature(mapping) === signature) || null;
  }

  upsertMapping(mapping) {
    const next = mapping instanceof ChannelSessionMapping ? mapping : new ChannelSessionMapping(mapping);
    const existing = this.getMapping(next.channel, next.conversationId, next.channelUserId);
    if (existing && existing.id !== next.id) {
      next.id = existing.id;
      next.createdAt = existing.createdAt;
      next.messageCount = next.messageCount || existing.messageCount;
    }
    next.updatedAt = new Date().toISOString();
    this.mappings.set(next.id, next);
    this._save();
    return next;
  }

  touchMapping(id, internalMessage = {}, context = {}) {
    const mapping = this.mappings.get(id);
    if (!mapping) return null;
    mapping.userId = internalMessage.userId || context.user_id || mapping.userId;
    mapping.agentId = internalMessage.agentId || context.agent_id || mapping.agentId;
    mapping.lastMessageAt = internalMessage.timestamp || new Date().toISOString();
    mapping.messageCount += 1;
    mapping.updatedAt = new Date().toISOString();
    this._save();
    return mapping;
  }

  listMappings(filters = {}) {
    return [...this.mappings.values()]
      .filter(mapping => matchesFilters(mapping, filters))
      .sort((a, b) => String(b.updatedAt).localeCompare(String(a.updatedAt)));
  }

  deleteMapping(id) {
    const deleted = this.mappings.delete(id);
    if (deleted) this._save();
    return deleted;
  }

  _load() {
    const raw = readJsonSafe(this.filePath, { schemaVersion: CHANNEL_SESSION_REGISTRY_SCHEMA_VERSION, mappings: [] });
    const mappings = Array.isArray(raw) ? raw : raw.mappings || [];
    for (const mapping of mappings) {
      const next = new ChannelSessionMapping(mapping);
      this.mappings.set(next.id, next);
    }
  }

  _save() {
    atomicWriteJson(this.filePath, {
      schemaVersion: CHANNEL_SESSION_REGISTRY_SCHEMA_VERSION,
      updatedAt: new Date().toISOString(),
      mappings: [...this.mappings.values()].map(mapping => mapping.toJSON()),
    }, {
      enabled: this.config.storage?.atomicWrites?.enabled !== false,
    });
  }
}

function createMappingId() {
  return `chanmap_${crypto.randomBytes(8).toString('hex')}`;
}

function createSyntheticSessionId() {
  return `channel_${crypto.randomBytes(6).toString('hex')}`;
}

function mappingSignature(mapping) {
  return [
    mapping.channel || 'unknown',
    mapping.conversationId || 'default',
    mapping.channelUserId || mapping.userId || 'anonymous',
  ].join('|');
}

function matchesFilters(mapping, filters = {}) {
  for (const [key, expected] of Object.entries(filters || {})) {
    if (expected === undefined || expected === null || expected === '') continue;
    const actual = mapping[key] ?? mapping[toCamel(key)] ?? null;
    if (actual !== expected) return false;
  }
  return true;
}

function toCamel(value) {
  return value.replace(/_([a-z])/g, (_, char) => char.toUpperCase());
}

function expandHome(value) {
  if (!value || !value.startsWith('~')) return value;
  if (value === '~') return os.homedir();
  if (value.startsWith('~/') || value.startsWith(`~${path.sep}`)) {
    return path.join(os.homedir(), value.slice(2));
  }
  return value;
}
