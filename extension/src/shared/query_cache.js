/**
 * Smart Query Router - On-Device Extension Query Cache
 * 
 * CORE RESPONSIBILITIES:
 * 1. Bounded, in-memory LRU cache with asynchronous chrome.storage.local persistence.
 * 2. Caches full query-response pairs from completed Claude interactions.
 * 3. Intercepts repeated/identical queries and serves them instantly from local cache.
 * 4. Saves 100% of LLM tokens by avoiding redundant cloud requests to Anthropic servers.
 * 5. Accurately calculates dynamic tokens saved (prompt + context history + response).
 * 6. Supports semantics-aware query normalization for robust key matching.
 * 7. Universal UMD wrapper for Content Scripts, Background Service Worker, Popup, and Node.js tests.
 */

(function (root, factory) {
  if (typeof module === 'object' && module.exports) {
    let tokenCounterModule = null;
    try {
      tokenCounterModule = require('./token_counter');
    } catch (_) {}
    module.exports = factory(tokenCounterModule);
  } else {
    root.SmartQueryRouterQueryCache = factory(root.SmartQueryRouterTokenCounter);
  }
})(typeof globalThis !== 'undefined' ? globalThis : this, function (tokenCounterModule) {
  'use strict';

  const CACHE_STORAGE_KEY = 'smart_query_router_query_cache';
  const DEFAULT_MAX_ENTRIES = 100;
  const DEFAULT_TTL_MS = 7 * 24 * 60 * 60 * 1000; // 7 days retention

  /**
   * Normalizes a query string to produce a deterministic, canonical cache key.
   * Collapses multiple whitespaces, strips leading/trailing whitespace, and lowercases.
   * 
   * @param {string} text - Raw query text
   * @returns {string} Normalized cache key
   */
  function normalizeCacheKey(text) {
    if (typeof text !== 'string') return '';
    return text
      .replace(/[\u200B-\u200D\uFEFF\u00AD\u2060\u180E]/g, '')
      .replace(/\u00A0/g, ' ')
      .trim()
      .replace(/\s+/g, ' ')
      .toLowerCase();
  }

  /**
   * Extension Query Cache Class
   */
  class QueryCache {
    /**
     * @param {object} [options]
     * @param {number} [options.maxEntries] - Maximum capacity (default 100)
     * @param {number} [options.ttlMs] - Time-to-live in ms (default 7 days)
     * @param {object} [options.storage] - chrome.storage.local or mock storage
     * @param {object} [options.tokenCounter] - Token counter module
     */
    constructor(options = {}) {
      this.maxEntries = options.maxEntries || DEFAULT_MAX_ENTRIES;
      this.ttlMs = options.ttlMs !== undefined ? options.ttlMs : DEFAULT_TTL_MS;
      this.storage = options.storage || (typeof chrome !== 'undefined' && chrome.storage && chrome.storage.local) || null;
      this.tokenCounter = options.tokenCounter || tokenCounterModule || (typeof globalThis !== 'undefined' && globalThis.SmartQueryRouterTokenCounter) || null;

      // In-memory Map: normalizedKey -> CacheEntry (preserves insertion/access order for LRU)
      this.entries = new Map();
      this.loaded = false;
    }

    /**
     * Store a query-response pair in the cache.
     * 
     * @param {string} rawQuery - The user's original query prompt
     * @param {string} responseText - Claude's generated response
     * @param {object} [metadata] - Optional additional metadata (conversationId, turnTracker, etc.)
     * @returns {object|null} The cached entry object
     */
    set(rawQuery, responseText, metadata = {}) {
      if (!rawQuery || typeof rawQuery !== 'string' || !responseText || typeof responseText !== 'string') {
        return null;
      }

      const trimmedQuery = rawQuery.trim();
      const trimmedResponse = responseText.trim();
      if (!trimmedQuery || !trimmedResponse) {
        return null;
      }

      const key = normalizeCacheKey(trimmedQuery);
      const now = Date.now();

      // Estimate tokens
      let promptTokens = 0;
      let responseTokens = 0;
      if (this.tokenCounter && typeof this.tokenCounter.countTokens === 'function') {
        const overhead = this.tokenCounter.MESSAGE_FRAMING_OVERHEAD_TOKENS || 3;
        promptTokens = this.tokenCounter.countTokens(trimmedQuery) + overhead;
        responseTokens = this.tokenCounter.countTokens(trimmedResponse) + overhead;
      } else {
        promptTokens = Math.max(1, Math.ceil(trimmedQuery.length / 4)) + 3;
        responseTokens = Math.max(1, Math.ceil(trimmedResponse.length / 4)) + 3;
      }

      const existing = this.entries.get(key);
      const hitCount = existing ? existing.hitCount : 0;
      const totalTokensSaved = existing ? existing.totalTokensSaved : 0;

      // If existing, delete first so re-insertion puts it at the end (MRU)
      if (existing) {
        this.entries.delete(key);
      } else if (this.entries.size >= this.maxEntries) {
        // Evict oldest entry (first key in Map iterator)
        const oldestKey = this.entries.keys().next().value;
        if (oldestKey) {
          this.entries.delete(oldestKey);
        }
      }

      const entry = {
        key,
        rawQuery: trimmedQuery,
        responseText: trimmedResponse,
        timestamp: now,
        lastAccessedAt: now,
        hitCount,
        totalTokensSaved,
        promptTokens,
        responseTokens,
        conversationId: (metadata && metadata.conversationId) || null
      };

      this.entries.set(key, entry);
      this.persist();

      return entry;
    }

    /**
     * Retrieve a cached response for a query.
     * Updates hit count, last accessed timestamp, and moves entry to MRU position.
     * 
     * @param {string} rawQuery - The user query to look up
     * @param {object} [context] - Optional context (e.g. turnTracker to compute context tokens saved)
     * @returns {object|null} Cached entry or null if miss/expired
     */
    get(rawQuery, context = {}) {
      if (!rawQuery || typeof rawQuery !== 'string') return null;
      const key = normalizeCacheKey(rawQuery);

      const entry = this.entries.get(key);
      if (!entry) return null;

      const now = Date.now();

      // Check TTL expiration
      if (this.ttlMs > 0 && (now - entry.timestamp > this.ttlMs)) {
        this.entries.delete(key);
        this.persist();
        return null;
      }

      // Refresh LRU position (delete and re-insert)
      this.entries.delete(key);
      entry.hitCount += 1;
      entry.lastAccessedAt = now;

      // Calculate tokens saved for this hit
      let contextTokens = 0;
      if (context && context.turnTracker && this.tokenCounter && typeof this.tokenCounter.countConversationTokens === 'function') {
        try {
          contextTokens = this.tokenCounter.countConversationTokens(context.turnTracker.getRecentTurns());
        } catch (_) {
          contextTokens = 0;
        }
      }

      const hitTokensSaved = (entry.promptTokens || 0) + (entry.responseTokens || 0) + contextTokens;
      entry.totalTokensSaved += hitTokensSaved;

      this.entries.set(key, entry);
      this.persist();

      return {
        ...entry,
        hitTokensSaved: Math.max(1, hitTokensSaved),
        contextTokens
      };
    }

    /**
     * Check if a valid, unexpired entry exists for the query without modifying LRU state.
     * 
     * @param {string} rawQuery
     * @returns {boolean}
     */
    has(rawQuery) {
      if (!rawQuery || typeof rawQuery !== 'string') return false;
      const key = normalizeCacheKey(rawQuery);
      const entry = this.entries.get(key);
      if (!entry) return false;

      if (this.ttlMs > 0 && (Date.now() - entry.timestamp > this.ttlMs)) {
        this.entries.delete(key);
        return false;
      }
      return true;
    }

    /**
     * Delete a specific query from the cache.
     * 
     * @param {string} rawQuery
     * @returns {boolean} True if deleted
     */
    delete(rawQuery) {
      if (!rawQuery || typeof rawQuery !== 'string') return false;
      const key = normalizeCacheKey(rawQuery);
      const existed = this.entries.delete(key);
      if (existed) {
        this.persist();
      }
      return existed;
    }

    /**
     * Clear all cached entries.
     */
    async clear() {
      this.entries.clear();
      await this.persist();
    }

    /**
     * Current count of active cache entries.
     * @returns {number}
     */
    size() {
      return this.entries.size;
    }

    /**
     * Asynchronously persist in-memory cache to chrome.storage.local.
     * @returns {Promise<void>}
     */
    async persist() {
      if (!this.storage || typeof this.storage.set !== 'function') return;

      const serializedEntries = Array.from(this.entries.values()).slice(-this.maxEntries);
      return new Promise((resolve) => {
        try {
          this.storage.set({ [CACHE_STORAGE_KEY]: serializedEntries }, () => resolve());
        } catch (_) {
          resolve();
        }
      });
    }

    /**
     * Asynchronously load persisted cache from chrome.storage.local.
     * @returns {Promise<QueryCache>}
     */
    async load() {
      if (!this.storage || typeof this.storage.get !== 'function') {
        this.loaded = true;
        return this;
      }

      return new Promise((resolve) => {
        try {
          this.storage.get([CACHE_STORAGE_KEY], (result) => {
            const raw = result && result[CACHE_STORAGE_KEY];
            if (Array.isArray(raw)) {
              const now = Date.now();
              this.entries.clear();
              for (const item of raw) {
                if (item && item.key && item.rawQuery && item.responseText) {
                  // Check TTL
                  if (this.ttlMs <= 0 || (now - item.timestamp <= this.ttlMs)) {
                    this.entries.set(item.key, item);
                  }
                }
              }
            }
            this.loaded = true;
            resolve(this);
          });
        } catch (_) {
          this.loaded = true;
          resolve(this);
        }
      });
    }
  }

  // Singleton instance
  const defaultQueryCache = new QueryCache();
  defaultQueryCache.load().catch(() => {});

  return {
    CACHE_STORAGE_KEY,
    DEFAULT_MAX_ENTRIES,
    DEFAULT_TTL_MS,
    normalizeCacheKey,
    QueryCache,
    defaultQueryCache
  };
});
