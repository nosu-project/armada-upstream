/**
 * A synchronous view over one prefix of ArmadaDB's KV, for the state that used
 * to live in localStorage.
 *
 * localStorage is synchronous, so the code that grew around it reads inside
 * `useState` initializers, react-query `initialData`, and render bodies — none
 * of which can await. KV is async. Rather than restructure every one of those
 * call sites around a promise, this keeps a memory map as the synchronous
 * source of truth, warms it from KV once, and writes through.
 *
 * What that costs, honestly: a read before the warm lands returns `undefined`
 * where localStorage would have returned the value. Every consumer here is a
 * CACHE or a resumable cursor whose miss path already exists (fetch the NIP-11
 * doc, start with an empty draft, re-sync from a lookback), and
 * {@link KvPrefixCache.subscribe} lets a component re-render when the warm
 * arrives. Nothing that must be correct on the first frame belongs here — that
 * data is still in localStorage, deliberately.
 *
 * The whole prefix is held in memory once warmed, so a cache is only suitable
 * for a key space bounded by something the user does (relays contacted,
 * channels typed in), not by traffic.
 *
 * ## Why move at all
 *
 * localStorage is ~5 MB per origin and `setItem` throws when it fills. The key
 * spaces moved here are the unbounded ones — one entry per relay ever
 * contacted, per channel ever typed in — with no eviction, so they were the
 * ones pushing every other writer toward that ceiling. Several already
 * swallowed quota failures silently.
 *
 * A cache knows nothing about where its key space used to live. The one-time
 * copy out of localStorage is a schema migration the startup gate runs (see
 * `LOCALSTORAGE_MOVES` in `db/schema.ts`), so there is exactly one place that
 * holds the old-to-new key mapping, it runs once rather than on every warm,
 * and a read here is only ever a read of KV.
 */
import { getArmadaDB } from "./armadaDB";

/** What the registry needs of a cache, independent of what it holds. */
interface RegisteredCache {
  ready(): Promise<void>;
  reset(): void;
}

/** Every cache built, so a logout can drop what they hold in memory. */
const registry = new Set<RegisteredCache>();

export interface KvPrefixCacheOpts {
  /** KV key prefix this cache owns. Entry keys are `prefix + id`. */
  prefix: string;
}

export class KvPrefixCache<T> {
  private readonly prefix: string;
  private readonly entries = new Map<string, T>();
  private readonly listeners = new Set<() => void>();
  private warming?: Promise<void>;

  /** Whether the memory map has been filled from KV yet. */
  warmed = false;

  constructor(opts: KvPrefixCacheOpts) {
    this.prefix = opts.prefix;
    registry.add(this);
  }

  /** The value for `id`, or `undefined` on a miss or before the warm lands. */
  get(id: string): T | undefined {
    return this.entries.get(id);
  }

  /** Every id currently held. Empty before the warm lands. */
  ids(): string[] {
    return [...this.entries.keys()];
  }

  /**
   * Write `id`. The memory map updates synchronously so the next read sees it;
   * the KV write is fire-and-forget, matching the `try {} catch {}` the
   * localStorage writers already wrapped themselves in.
   */
  set(id: string, value: T): void {
    this.entries.set(id, value);
    this.notify();
    void getArmadaDB().kv.set(this.prefix + id, value).catch(() => undefined);
  }

  /** Forget `id`. */
  delete(id: string): void {
    this.entries.delete(id);
    this.notify();
    void getArmadaDB().kv.delete(this.prefix + id).catch(() => undefined);
  }

  /** Fill the memory map from KV. Idempotent, and shared by concurrent callers. */
  ready(): Promise<void> {
    this.warming ??= this.warm().catch(() => {
      // Retry on the next call rather than caching a rejection. A cache that
      // never warms degrades to a permanent miss, not to wrong answers.
      this.warming = undefined;
    });
    return this.warming;
  }

  private async warm(): Promise<void> {
    const { kv } = getArmadaDB();
    const keys = await kv.keys(this.prefix);
    for (const key of keys) {
      const value = await kv.get<T>(key);
      if (value === undefined || value === null) continue;
      const id = key.slice(this.prefix.length);
      // A write that happened while the warm was in flight is newer than what
      // KV had when the scan started, so it wins.
      if (!this.entries.has(id)) this.entries.set(id, value);
    }

    this.warmed = true;
    this.notify();
  }

  /**
   * Re-render on change. Returns an unsubscribe.
   *
   * The warm is the reason this exists: a component that mounted during boot
   * read an empty cache, and has no other signal that the real values arrived.
   */
  subscribe(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  private notify(): void {
    for (const listener of this.listeners) {
      try {
        listener();
      } catch {
        // A listener must never break a write.
      }
    }
  }

  /**
   * Delete every entry this cache owns, from KV as well as memory.
   *
   * Leaves the cache WARMED: the store is now known to be empty, so a
   * subsequent miss is an answer rather than a not-yet.
   */
  async clear(): Promise<void> {
    const { kv } = getArmadaDB();
    const keys = await kv.keys(this.prefix).catch(() => [] as string[]);
    await Promise.all(keys.map((key) => kv.delete(key).catch(() => undefined)));
    this.entries.clear();
    this.warming = Promise.resolve();
    this.warmed = true;
    this.notify();
  }

  /** Drop everything held in memory, and warm again on the next `ready()`. */
  reset(): void {
    this.entries.clear();
    this.warming = undefined;
    this.warmed = false;
    this.notify();
  }
}

/**
 * Drop every cache's memory map (logout, and after the localStorage migration
 * writes underneath one).
 *
 * `purgeArmadaDB` deletes the KV database, but these hold their own copy —
 * without this, the next account would read the previous one's drafts and
 * palettes straight out of memory.
 */
export function resetKvCaches(): void {
  for (const cache of registry) cache.reset();
}
