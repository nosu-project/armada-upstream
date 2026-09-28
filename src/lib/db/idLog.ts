/**
 * A set of fixed-width ids persisted as an append-only log of KV chunks, so an
 * add rewrites only the open chunk instead of a megabyte-sized whole-set value.
 * Ids are concatenated (each exactly `idChars`); FIFO order is eviction order.
 */

export interface IdLogKV {
  set(key: string, value: string): Promise<void>;
  delete(key: string): Promise<void>;
  list<T>(selector: { prefix: string }): Promise<{ key: string; value: T }[]>;
}

export interface IdLogOptions {
  /** KV key prefix; chunks are `<prefix><10-digit seq>`. */
  prefix: string;
  /** Length of every id. */
  idChars: number;
  chunkIds: number;
  keepChunks: number;
  /** Debounce for rewriting the open chunk. */
  flushMs: number;
}

export class IdLog {
  private seq = 0;
  private open: string[] = [];
  private loaded = false;
  private loading: Promise<string[]> | undefined;
  private timer: ReturnType<typeof setTimeout> | undefined;

  constructor(
    private readonly kv: () => IdLogKV,
    private readonly opts: IdLogOptions,
  ) {}

  /** The most ids the log holds once full. */
  get capacity(): number {
    return this.opts.chunkIds * this.opts.keepChunks;
  }

  private chunkKey(seq: number): string {
    return `${this.opts.prefix}${String(seq).padStart(10, "0")}`;
  }

  /** Every persisted id, oldest first. Loaded once; never rejects. */
  load(): Promise<string[]> {
    this.loading ??= (async () => {
      const ids: string[] = [];
      try {
        const chunks = await this.kv().list<string>({ prefix: this.opts.prefix });
        chunks.sort((a, b) => (a.key < b.key ? -1 : a.key > b.key ? 1 : 0));
        const kept = chunks.slice(-this.opts.keepChunks);
        for (const stale of chunks.slice(0, chunks.length - kept.length)) {
          void this.kv().delete(stale.key).catch(() => undefined);
        }
        const width = this.opts.idChars;
        for (const { value } of kept) {
          if (typeof value !== "string") continue;
          for (let i = 0; i + width <= value.length; i += width) ids.push(value.slice(i, i + width));
        }
        const last = kept.at(-1);
        // A fresh chunk: never rewrite one an earlier session wrote.
        this.seq = last ? Number(last.key.slice(this.opts.prefix.length)) + 1 : 0;
      } catch {
        // No store: nothing persisted, and nothing will be.
      }
      this.loaded = true;
      if (this.open.length > 0) this.flush();
      return ids;
    })();
    return this.loading;
  }

  /** Append `id` (the caller dedupes). Persisted within `flushMs`. */
  add(id: string): void {
    if (id.length !== this.opts.idChars) return;
    this.open.push(id);
    if (this.open.length >= this.opts.chunkIds) this.flush();
    else this.timer ??= setTimeout(() => this.flush(), this.opts.flushMs);
  }

  /** Forget everything, persisted included (test seams). */
  async clear(): Promise<void> {
    if (this.timer !== undefined) clearTimeout(this.timer);
    this.timer = undefined;
    this.open = [];
    this.seq = 0;
    this.loaded = true;
    this.loading = Promise.resolve([]);
    try {
      const chunks = await this.kv().list<string>({ prefix: this.opts.prefix });
      await Promise.all(chunks.map((c) => this.kv().delete(c.key)));
    } catch {
      // No store: nothing to clear.
    }
  }

  private flush(): void {
    if (this.timer !== undefined) clearTimeout(this.timer);
    this.timer = undefined;
    // Before the load has placed `seq`, a write could land on an old chunk.
    if (!this.loaded || this.open.length === 0) return;
    const written = this.seq;
    void this.kv().set(this.chunkKey(written), this.open.join("")).catch(() => undefined);
    if (this.open.length >= this.opts.chunkIds) {
      this.seq += 1;
      this.open = [];
      const expired = written - this.opts.keepChunks + 1;
      if (expired >= 0) void this.kv().delete(this.chunkKey(expired)).catch(() => undefined);
    }
  }
}
