/**
 * `list_models` catalogue cache.
 *
 * Rationale: a host's model catalogue is a property of the machine, not of a
 * moment in time. Re-running a full round trip through the relay to the
 * workspace Pi to answer a question whose answer cannot change mid-connection
 * is pure latency. The catalogue is therefore remembered per
 * (relay, host, room) and stays valid for the WHOLE connection.
 *
 * Two rules keep the shortcut honest, and deliberately replace the earlier
 * wall-clock TTL:
 *
 *   1. The cache is bound to a CONNECTION SCOPE (`catalogueScope`) and dropped
 *      whole whenever that scope changes — another relay, another host, an
 *      explicit forget, or a reconnect with a new identity. A reconnect is
 *      exactly the moment a catalogue is re-read, because it is the moment the
 *      machine may have changed.
 *   2. An entry is corrected IN PLACE when this client switches the model
 *      itself (`confirmCachedModel`, after the host's `action_ok`), so the
 *      remembered `current` never goes stale from our own action.
 *
 * Why no TTL: a timed expiry turned a stable answer into a periodic network
 * round trip. It also could not do its job properly — this web client does not
 * consume the relay's `room_meta` stream, so an external change (another
 * paired device, the TUI's own `/model`) is invisible here either way; the TTL
 * only bounded how OFTEN the client re-asked, which is a latency cost, not a
 * correctness guarantee. Connection scope gives the same freshness guarantee at
 * a bound the user can reason about: the catalogue is re-read when they
 * reconnect, and when they ask for it explicitly.
 *
 * Persistence: an in-memory Map dies on every page load, so a plain F5 sent the
 * picker back to "asking the host…" even though nothing about the machine had
 * changed — the exact regression this file now guards against. Entries are
 * therefore mirrored into a `StorageLike` (localStorage in the browser) under
 * the same scope key, and the in-memory map is only a fast layer in front of
 * it. Storage is optional: a throwing or absent store degrades to in-memory,
 * never to an error.
 *
 * Pure and dependency-free (no wire, no DOM, no React), so the invalidation
 * rules are directly verifiable in Node.
 */

/** The slice of the Web Storage API this cache needs. Structurally compatible
 *  with `localStorage`, so the adapter can pass what it already has. */
export interface CatalogueStorage {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  removeItem(key: string): void;
}

/** Namespace for every persisted catalogue entry. Versioned so a future shape
 *  change can abandon old rows instead of misreading them. */
export const CATALOGUE_STORAGE_PREFIX = "remote-pi:catalogue:v1:";

export interface CatalogueEntry<TModel, TCurrent> {
  readonly models: readonly TModel[];
  /** The host-reported `current`, or `undefined` when the Pi has no active
   *  session ctx — preserved verbatim, never synthesised here. */
  readonly current: TCurrent | undefined;
}

interface StoredEntry<TModel, TCurrent> extends CatalogueEntry<TModel, TCurrent> {
  /** When the entry was written. Diagnostic only: validity is the connection's,
   *  not the clock's. */
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
  private readonly storage: CatalogueStorage | null;

  /** `storage` is optional: without it the cache is memory-only (unit tests,
   *  a browser with storage disabled). */
  constructor(storage: CatalogueStorage | null = null) {
    this.storage = storage;
  }

  /** A remembered entry, or null. Memory first, then the persisted layer — so a
   *  fresh page load (empty map) still answers without a relay round trip.
   *  Entries do NOT expire on their own: validity is the connection's, which
   *  `clear()` expresses. */
  get(key: string): CatalogueEntry<TModel, TCurrent> | null {
    const entry = this.entries.get(key);
    if (entry !== undefined) return { models: entry.models, current: entry.current };
    const restored = this._readPersisted(key);
    if (restored === null) return null;
    // Warm the memory layer so repeated reads stay allocation-free.
    this.entries.set(key, restored);
    return { models: restored.models, current: restored.current };
  }

  set(key: string, entry: CatalogueEntry<TModel, TCurrent>): void {
    const stored: StoredEntry<TModel, TCurrent> = {
      models: entry.models,
      current: entry.current,
      at: Date.now(),
    };
    this.entries.set(key, stored);
    this._writePersisted(key, stored);
  }

  /** Drops ONE room (this client switched its own model there). */
  invalidate(key: string): void {
    this.entries.delete(key);
    this._removePersisted(key);
  }

  /** Drops EVERY entry: the connection scope changed, so nothing remembered
   *  belongs to the connection that follows. This is the ONLY expiry. */
  clear(): void {
    this.entries.clear();
    this._clearPersisted();
  }

  /** Entry count (memory layer only; the persisted layer is not enumerated). */
  get size(): number {
    return this.entries.size;
  }

  // ── persistence ───────────────────────────────────────────────────────────

  private _readPersisted(key: string): StoredEntry<TModel, TCurrent> | null {
    if (this.storage === null) return null;
    let raw: string | null;
    try {
      raw = this.storage.getItem(CATALOGUE_STORAGE_PREFIX + key);
    } catch {
      return null; // storage disabled / quota — memory still works
    }
    if (raw === null) return null;
    try {
      const parsed = JSON.parse(raw) as StoredEntry<TModel, TCurrent>;
      // A malformed or version-drifted row must never poison the picker.
      if (!Array.isArray(parsed.models)) return null;
      return {
        models: parsed.models,
        current: parsed.current,
        at: typeof parsed.at === "number" ? parsed.at : 0,
      };
    } catch {
      return null;
    }
  }

  private _writePersisted(key: string, entry: StoredEntry<TModel, TCurrent>): void {
    if (this.storage === null) return;
    try {
      this.storage.setItem(CATALOGUE_STORAGE_PREFIX + key, JSON.stringify(entry));
    } catch {
      // Quota exceeded / storage disabled: the memory layer already has it, so
      // the current page still works. Losing the cross-load shortcut is not
      // worth failing a model read over.
    }
  }

  private _removePersisted(key: string): void {
    if (this.storage === null) return;
    try {
      this.storage.removeItem(CATALOGUE_STORAGE_PREFIX + key);
    } catch {
      /* best effort */
    }
  }

  /** Removes every row this cache owns, leaving other apps' keys alone. */
  private _clearPersisted(): void {
    if (this.storage === null) return;
    const doomed: string[] = [];
    try {
      const store = this.storage as CatalogueStorage & { key?(i: number): string | null; length?: number };
      if (typeof store.length === "number" && typeof store.key === "function") {
        for (let i = 0; i < store.length; i += 1) {
          const k = store.key(i);
          if (k !== null && k.startsWith(CATALOGUE_STORAGE_PREFIX)) doomed.push(k);
        }
      }
    } catch {
      return;
    }
    for (const k of doomed) {
      try {
        this.storage.removeItem(k);
      } catch {
        /* best effort */
      }
    }
  }
}
