'use strict';
// Coalesced, revision-guarded read cache for navigation snapshots.
// Loaders must be read-only; mutations call invalidate() themselves.
class StatusCache {
  constructor({ ttl = 3000, now = Date.now } = {}) {
    this.ttl = ttl;
    this.now = now;
    this.entries = new Map();
    this.generations = new Map();
    this.revision = 0;
    this.closed = false;
    this.counters = { hits: 0, misses: 0, coalesced: 0, loads: 0, durationMs: 0, invalidations: 0, stale: 0 };
  }
  _generation(key) { return (this.generations.get(key) || 0) + 1; }
  _current(key, generation, revision) {
    return !this.closed && revision === this.revision && (this.generations.get(key) || 0) === generation;
  }
  async request(key, loader, { fresh = false, ttl = this.ttl } = {}) {
    if (this.closed) return { status: 'closed' };
    if (typeof loader !== 'function') throw new Error('状态读取器无效');
    const entry = this.entries.get(key);
    if (!fresh && entry) {
      if (entry.inFlight) { this.counters.coalesced += 1; return entry.inFlight; }
      if (entry.value !== undefined && this.now() - entry.at < ttl) {
        this.counters.hits += 1;
        return { status: 'ok', value: entry.value };
      }
    }
    this.counters.misses += 1;
    const revision = this.revision;
    const generation = this._generation(key);
    this.generations.set(key, generation);
    const started = this.now();
    const promise = (async () => {
      try {
        const value = await loader();
        if (this.closed) return { status: 'closed' };
        if (this._current(key, generation, revision)) {
          this.entries.set(key, { value, at: this.now(), generation });
          return { status: 'ok', value };
        }
        this.counters.stale += 1;
        return { status: 'stale' };
      } catch (error) {
        if (this._current(key, generation, revision)) this.entries.delete(key);
        throw error;
      } finally {
        this.counters.loads += 1;
        this.counters.durationMs += this.now() - started;
      }
    })();
    this.entries.set(key, { inFlight: promise, at: this.now(), generation });
    try { return await promise; }
    finally {
      const current = this.entries.get(key);
      if (current && current.inFlight === promise && current.value === undefined) this.entries.delete(key);
    }
  }
  async get(key, loader, options = {}) {
    if (this.closed) throw new Error('状态缓存已关闭');
    const result = await this.request(key, loader, options);
    if (result.status !== 'ok') {
      const error = new Error(result.status === 'closed' ? '状态缓存已关闭' : '状态读取已过期');
      error.stale = result.status !== 'closed';
      throw error;
    }
    return result.value;
  }
  peek(key, { ttl = this.ttl } = {}) {
    const entry = this.entries.get(key);
    if (!entry || entry.value === undefined || this.now() - entry.at >= ttl) return undefined;
    return entry.value;
  }
  invalidate(prefix = '') {
    let removed = 0;
    for (const key of [...this.entries.keys()]) {
      if (!prefix || key.startsWith(prefix)) {
        this.entries.delete(key);
        this.generations.set(key, this._generation(key));
        removed += 1;
      }
    }
    for (const key of [...this.generations.keys()]) {
      if (!prefix || key.startsWith(prefix)) this.generations.set(key, this._generation(key));
    }
    this.revision += 1;
    this.counters.invalidations += 1;
    return removed;
  }
  metrics() { return { ...this.counters }; }
  close() {
    this.closed = true;
    this.revision += 1;
    this.entries.clear();
  }
}
module.exports = { StatusCache };
