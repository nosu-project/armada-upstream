/**
 * Per-tenant memory of committed event ids, so re-writes are skipped (the relay
 * layer re-caches the same events across rounds: 1024 rows cost 6518 writes).
 * Ids hash content, so this is a dedupe that can't go stale.
 *  - Record only AFTER the write resolves ("resolved means durable" — parked
 *    wraps are ACKed on it).
 *  - {@link forget} on every `remove()` (filters can't be mapped to ids).
 *  - FIFO-bounded to keep long-lived tabs flat.
 */

/** Ids per tenant store. Sized for a session's traffic, not a database. */
const MAX_IDS = 20_000;

export class WrittenIds {
  private ids = new Set<string>();

  has(id: string): boolean {
    return this.ids.has(id);
  }

  /** Record `id` as committed. Call only after the write has resolved. */
  add(id: string): void {
    if (this.ids.size >= MAX_IDS) {
      // Set iterates in insertion order.
      const oldest = this.ids.keys().next();
      if (!oldest.done) this.ids.delete(oldest.value);
    }
    this.ids.add(id);
  }

  /** Drop everything (on `remove()`, whose filter can't be evaluated here). */
  forget(): void {
    this.ids.clear();
  }

  get size(): number {
    return this.ids.size;
  }
}
