/**
 * A synchronous view over one KV prefix, for state moved out of localStorage
 * (~5 MB, `setItem` throws when full) whose readers can't await. A memory map
 * is the sync source of truth, warmed once from KV, written through.
 *
 * Reads before the warm return `undefined`, so only caches/resumable cursors
 * with an existing miss path belong here; {@link KvPrefixCache.subscribe}
 * re-renders on warm. The whole prefix is held in memory, so the key space must
 * be bounded by user actions, not traffic.
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
  /** Bumped by every warm and every emptying; a stale warm doesn't apply (see {@link clear}). */
  private generation = 0;

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
   * the KV write is fire-and-forget.
   */
  set(id: string, value: T): void {
    this.entries.set(id, value);
    this.notify();
    void getArmadaDB().kv.set(this.prefix + id, value).catch(() => undefined);
  }

  delete(id: string): void {
    this.entries.delete(id);
    this.notify();
    void getArmadaDB().kv.delete(this.prefix + id).catch(() => undefined);
  }

  /** Fill the memory map from KV. Idempotent, and shared by concurrent callers. */
  ready(): Promise<void> {
    this.warming ??= this.warm(++this.generation).catch(() => {
      // Retry next call; a never-warming cache degrades to misses, not wrong answers.
      this.warming = undefined;
    });
    return this.warming;
  }

  private async warm(generation: number): Promise<void> {
    // One scan with values (a get per key is a bridge round trip each on Android).
    const entries = await getArmadaDB().kv.list<T>({ prefix: this.prefix });

    // A clear()/reset() mid-warm moved the generation; don't refill with stale entries.
    if (generation !== this.generation) return;

    for (const { key, value } of entries) {
      if (value === undefined || value === null) continue;
      const id = key.slice(this.prefix.length);
      // A write during the warm is newer than the scan.
      if (!this.entries.has(id)) this.entries.set(id, value);
    }

    this.warmed = true;
    this.notify();
  }

  /** Re-render on change (notably the warm landing). Returns an unsubscribe. */
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

  /** Delete every entry from KV and memory; leaves the cache warmed (known empty). */
  async clear(): Promise<void> {
    const { kv } = getArmadaDB();
    const entries = await kv.list({ prefix: this.prefix }).catch(() => []);
    await Promise.all(entries.map(({ key }) => kv.delete(key).catch(() => undefined)));
    this.entries.clear();
    // Retire any in-flight warm.
    this.generation++;
    this.warming = Promise.resolve();
    this.warmed = true;
    this.notify();
  }

  /** Drop everything held in memory, and warm again on the next `ready()`. */
  reset(): void {
    this.entries.clear();
    this.generation++;
    this.warming = undefined;
    this.warmed = false;
    this.notify();
  }
}

/**
 * Drop every cache's memory map (logout).
 * Without this the next account would read the previous one's data from memory.
 */
export function resetKvCaches(): void {
  for (const cache of registry) cache.reset();
}
