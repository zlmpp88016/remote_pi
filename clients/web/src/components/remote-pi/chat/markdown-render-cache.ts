/** Bounded cache of React Markdown element descriptions (not parsed trees).
 * Content/theme/width identity and exact-text collision checks bound reuse.
 * The mounted parser itself is memoized by text in markdown.tsx. */

/** Entries retained before the least-recently-used one is dropped. */
export const MARKDOWN_CACHE_MAX_ENTRIES = 96;
/** Content bytes retained across all entries. */
export const MARKDOWN_CACHE_MAX_BYTES = 2 * 1024 * 1024;

/**
 * FNV-1a 32-bit hash of the content, hex encoded.
 *
 * A hash, not a length: the key must distinguish two messages of the same size.
 * 32 bits is enough here because a collision is only ever a miss — the cache
 * verifies the stored text on read.
 */
export function markdownContentHash(text: string): string {
  let hash = 0x811c9dc5;
  for (let i = 0; i < text.length; i += 1) {
    hash ^= text.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return hash.toString(16).padStart(8, "0");
}

/** Width is bucketed so a 1px resize does not invalidate every entry. */
export function markdownWidthBucket(width: number): number {
  if (!Number.isFinite(width) || width <= 0) return 0;
  return Math.max(0, Math.round(width / 16) * 16);
}

export interface MarkdownCacheKey {
  text: string;
  /** Resolved palette (`light` | `dark`) — the accent preset does not reflow. */
  theme: string;
  /** Measured container width in CSS pixels (bucketed). */
  width: number;
}

/** Stable key string for `get`/`set`. */
export function markdownCacheKey(key: MarkdownCacheKey): string {
  return `${key.theme}|${markdownWidthBucket(key.width)}|${markdownContentHash(key.text)}`;
}

export interface MarkdownCacheEntry<T> {
  key: string;
  text: string;
  theme: string;
  width: number;
  bytes: number;
  touched: number;
  value: T;
}

export interface MarkdownCacheOptions {
  maxEntries?: number;
  maxBytes?: number;
  now?: () => number;
}

/**
 * LRU cache of Markdown element descriptions.
 *
 * Generic over the value so it can hold a React element without importing React
 * (which keeps it testable in plain Node).
 */
export class MarkdownRenderCache<T> {
  private readonly entries = new Map<string, MarkdownCacheEntry<T>>();
  private readonly maxEntries: number;
  private readonly maxBytes: number;
  private readonly now: () => number;
  private totalBytes = 0;

  constructor(options: MarkdownCacheOptions = {}) {
    this.maxEntries = options.maxEntries ?? MARKDOWN_CACHE_MAX_ENTRIES;
    this.maxBytes = options.maxBytes ?? MARKDOWN_CACHE_MAX_BYTES;
    this.now = options.now ?? Date.now;
  }

  get entriesCount(): number {
    return this.entries.size;
  }

  get bytes(): number {
    return this.totalBytes;
  }

  /** Render-cache hit, or null. A hash collision is rejected by exact compare. */
  get(key: MarkdownCacheKey): T | null {
    const id = markdownCacheKey(key);
    const entry = this.entries.get(id);
    if (entry === undefined) return null;
    if (entry.text !== key.text || entry.theme !== key.theme) return null;
    entry.touched = this.now();
    return entry.value;
  }

  /** Store one rendered value, evicting LRU entries until both ceilings hold. */
  set(key: MarkdownCacheKey, value: T): void {
    const id = markdownCacheKey(key);
    const bytes = new TextEncoder().encode(key.text).length;
    const previous = this.entries.get(id);
    if (previous !== undefined) {
      this.totalBytes -= previous.bytes;
      this.entries.delete(id);
    }
    if (bytes > this.maxBytes) return;
    this.entries.set(id, {
      key: id,
      text: key.text,
      theme: key.theme,
      width: key.width,
      bytes,
      touched: this.now(),
      value,
    });
    this.totalBytes += bytes;
    while (this.entries.size > this.maxEntries || this.totalBytes > this.maxBytes) {
      let oldestKey: string | null = null;
      let oldestAt = Number.POSITIVE_INFINITY;
      for (const [entryKey, entry] of this.entries) {
        if (entry.touched < oldestAt) {
          oldestAt = entry.touched;
          oldestKey = entryKey;
        }
      }
      if (oldestKey === null) break;
      const victim = this.entries.get(oldestKey);
      if (victim !== undefined) this.totalBytes -= victim.bytes;
      this.entries.delete(oldestKey);
    }
  }

  clear(): void {
    this.entries.clear();
    this.totalBytes = 0;
  }
}

/**
 * The process-wide cache for rendered transcript Markdown.
 *
 * Module-level on purpose: the cache must survive a row unmount, and a new
 * component instance is exactly what happens when a row re-enters the window.
 */
export const markdownRenderCache = new MarkdownRenderCache<unknown>();
