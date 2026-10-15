/**
 * `list_models` catalogue cache.
 *
 * Rationale: a host's model catalogue barely changes, but the picker used to
 * re-run a full round trip through the relay to the workspace Pi on EVERY
 * open. The catalogue is therefore remembered per (relay, host, room) — the
 * identity triple that makes two entries the same source — so reopening the
 * picker is instant.
 *
 * Two limits keep the shortcut honest:
 *
 *   1. An entry EXPIRES (`ttlMs`). This web client does not consume the relay's
 *      `room_meta` stream, so an external change — another paired device, or
 *      the TUI's own `/model` — cannot be observed here. The TTL bounds how
 *      long a stale `current` can be shown; it is not a cache-only nicety.
 *   2. An entry is dropped EXPLICITLY when this client changes the model itself
 *      (`model_set`), and the whole cache is cleared when the pairing identity
 *      changes (another relay/host, or an explicit forget), so a catalogue can
 *      never be attributed to a host that did not report it.
 *
 * Pure and dependency-free (no wire, no DOM, no React) with an injectable
 * clock, so the expiry and invalidation rules are directly verifiable in Node.
 */

export interface CatalogueEntry<TModel, TCurrent> {
  readonly models: readonly TModel[];
  /** The host-reported `current`, or `undefined` when the Pi has no active
   *  session ctx — preserved verbatim, never synthesised here. */
  readonly current: TCurrent | undefined;
}

interface StoredEntry<TModel, TCurrent> extends CatalogueEntry<TModel, TCurrent> {
  readonly at: number;
}

/**
 * The identity of a catalogue SOURCE. A pairing change invalidates everything
 * under it, so a source covers the relay + host; the room is part of each
 * entry key. A relay URL and a host epk cannot contain a raw `|`, so the
 * separator is unambiguous.
 */
export function catalogueScope(relayUrl: string, hostEpk: string): string {
  return `${relayUrl}|${hostEpk}`;
}

/** Entry key: one room's catalogue within a source. A room id is derived from
 *  the workspace cwd/name and is NOT host-scoped, so the source must be part
 *  of the key — the same room id can exist on two hosts. */
export function catalogueKey(scope: string, roomId: string): string {
  return `${scope}|${roomId}`;
}

export class ModelCatalogueCache<TModel, TCurrent> {
  private readonly entries = new Map<string, StoredEntry<TModel, TCurrent>>();
  private readonly ttlMs: number;
  private readonly now: () => number;

  constructor(ttlMs: number, now: () => number = Date.now) {
    this.ttlMs = ttlMs;
    this.now = now;
  }

  /** A fresh entry, or null. An expired entry is EVICTED on read, so a later
   *  `set` for the same key cannot resurrect stale bytes. */
  get(key: string): CatalogueEntry<TModel, TCurrent> | null {
    const entry = this.entries.get(key);
    if (entry === undefined) return null;
    if (this.now() - entry.at >= this.ttlMs) {
      this.entries.delete(key);
      return null;
    }
    return { models: entry.models, current: entry.current };
  }

  set(key: string, entry: CatalogueEntry<TModel, TCurrent>): void {
    this.entries.set(key, { models: entry.models, current: entry.current, at: this.now() });
  }

  /** Drops ONE room (this client switched its own model there). */
  invalidate(key: string): void {
    this.entries.delete(key);
  }

  /** Drops EVERY entry: the pairing identity changed, so nothing remembered
   *  belongs to the connection that follows. */
  clear(): void {
    this.entries.clear();
  }

  /** Entry count — including an entry that expired but was not read yet. */
  get size(): number {
    return this.entries.size;
  }
}

/** Ten minutes: long enough that reopening the picker is free, short enough
 *  that a model switched from another device is not shown as current for long. */
export const MODEL_CACHE_TTL_MS = 10 * 60 * 1000;
