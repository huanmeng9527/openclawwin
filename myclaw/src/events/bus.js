import { RuntimeEvent } from './models.js';

export class EventBus {
  constructor(options = {}) {
    this.maxRecentEvents = options.maxRecentEvents || options.maxRecent || 200;
    this._recent = [];
    this._listeners = new Set();
  }

  publish(event) {
    const next = event instanceof RuntimeEvent ? event : new RuntimeEvent(event);
    this._recent.push(next);
    if (this._recent.length > this.maxRecentEvents) {
      this._recent.splice(0, this._recent.length - this.maxRecentEvents);
    }
    for (const listener of [...this._listeners]) {
      try {
        listener(next);
      } catch {
        // EventBus is best-effort; listener failures must not affect runtime behavior.
      }
    }
    return next;
  }

  subscribe(listener) {
    this._listeners.add(listener);
    return () => this.unsubscribe(listener);
  }

  unsubscribe(listener) {
    return this._listeners.delete(listener);
  }

  recent(limit = this.maxRecentEvents) {
    const safeLimit = parseLimit(limit, this.maxRecentEvents);
    return this._recent.slice(-safeLimit);
  }

  clear() {
    this._recent = [];
  }

  listenerCount() {
    return this._listeners.size;
  }
}

function parseLimit(value, fallback) {
  const parsed = Number.parseInt(value, 10);
  if (!Number.isFinite(parsed) || parsed <= 0) return fallback;
  return parsed;
}
