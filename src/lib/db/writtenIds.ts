/**
 * Per-tenant memory of event ids already committed, so a re-write is skipped.
 *
 * The relay layer caches every event that flows out of every `.query()` and
 * `.req()` (see `NostrBatcher.cacheEvents`) — which is the right policy and the
 * wrong cost. `NPool.query` dedupes within one round, but nothing dedupes ACROSS
 * rounds: the same profile served to five consumers, or streamed by six relays,
 * is written five or six times. Measured on a real boot, 1024 stored rows in the
 * `main` tenant cost 6518 write calls, each one an entry in a batch, a promise, a
 * tag-index extraction, and a share of a transaction.
 *
 * An event id is a hash over the event's own content, so "already committed" is a
 * COMPLETE answer: there is nothing a second write of the same id could store
 * that the first did not. That is what makes this a dedupe rather than a cache —
 * it cannot serve a stale answer, because it serves no answer at all.
 *
 * Three rules keep it honest:
 *
 *  - An id is recorded only AFTER the write resolves. The write contract is
 *    "resolved means durable" (`writeRumors` ACKs — and therefore destroys —
 *    parked wraps on the strength of it), so recording an id before its commit
 *    would let a later skip claim durability for a write that failed.
 *  - {@link forget} on every `remove()`. A removed event that is later
 *    re-received has to be storable again, and the removal is expressed as a
 *    filter rather than a list of ids, so the honest response to one is to drop
 *    the whole set rather than guess which ids it matched.
 *  - FIFO-bounded. Ids are 64 chars and the working set is the session's
 *    traffic, not the database's contents; the cap makes a long-lived tab's
 *    memory flat instead of monotonic.
 *
 * Note that skipping a superseded write is also correct: if the store declined
 * the event because a newer version at its coordinate is present, a second
 * attempt would decline it too.
 */

/** Ids per tenant store. Sized for a session's traffic, not a database. */
const MAX_IDS = 20_000;

export class WrittenIds {
  private ids = new Set<string>();

  /** Whether `id` is known to be committed already. */
  has(id: string): boolean {
    return this.ids.has(id);
  }

  /** Record `id` as committed. Call only after the write has resolved. */
  add(id: string): void {
    if (this.ids.size >= MAX_IDS) {
      // Oldest insertion first — `Set` iterates in insertion order.
      const oldest = this.ids.keys().next();
      if (!oldest.done) this.ids.delete(oldest.value);
    }
    this.ids.add(id);
  }

  /**
   * Drop everything. Called on `remove()`, whose filter this class cannot
   * evaluate — so the only safe answer is to stop claiming knowledge.
   */
  forget(): void {
    this.ids.clear();
  }

  /** How many ids are remembered (for the profiler / tests). */
  get size(): number {
    return this.ids.size;
  }
}
