import type { NostrEvent, NostrFilter } from '@nostrify/types';
import type { NPool, NStore } from '@nostrify/nostrify';

import { recordRelayProvenanceBatch } from '@/lib/relayProvenance';
import { logNostrReq } from '@/lib/nostrQueryLog';

/** kind 39000 — NIP-29 group metadata, the channel-directory event. */
const KIND_GROUP_METADATA = 39000;

/** The relay/group handle shape we wrap for caching: query + req. */
type NRelayLike = ReturnType<NPool['relay']>;

/** Maximum number of items per batch to avoid hitting relay filter limits. */
const MAX_BATCH_SIZE = 50;

/**
 * Grace window (ms) after the first relay EOSEs before a replaceable-event
 * (profile) batch resolves. The pool's global default (300ms) routinely cuts
 * off slower/cold relays that hold the kind-0 — capped at 1000ms so a profile
 * still has a real chance to arrive without stalling the UI.
 */
const PROFILE_EOSE_GRACE_MS = 1000;

/**
 * Hard deadline on a COALESCED shared query (ms). The shared upstream is
 * deliberately driven without any caller's signal (one caller aborting must
 * not cancel the others) — but with NO deadline at all, a request that never
 * settles (a REQ swallowed by a mid-flight NIP-42 handshake, a half-open
 * socket) parks in `inflightQueries` forever, and every later identical query
 * (channel backfills re-ask the exact same filters every round) joins the
 * corpse instead of opening a fresh request. That wedged the whole sync
 * pipeline until an app restart. Generous — every real caller times out
 * sooner (8-15s); this only exists so the coalesce key can't be poisoned.
 */
const SHARED_QUERY_DEADLINE_MS = 30_000;

/**
 * Pending request waiting for a batched query result.
 * Each caller gets its own resolve/reject and optional abort signal.
 */
interface PendingRequest<V> {
  key: string;
  resolve: (value: V) => void;
  reject: (error: unknown) => void;
  signal?: AbortSignal;
}

/** Anything that can be rejected and may carry an abort signal. */
interface AbortableRequest {
  reject: (error: unknown) => void;
  signal?: AbortSignal;
}

/**
 * Drop the requests whose signal has already aborted (rejecting them with their
 * reason) and return only the still-live requests. Shared by every collector's
 * `flush` prelude.
 */
function partitionLive<R extends AbortableRequest>(batch: R[]): R[] {
  const live: R[] = [];
  for (const req of batch) {
    if (req.signal?.aborted) req.reject(req.signal.reason);
    else live.push(req);
  }
  return live;
}

/**
 * Build the combined AbortController for a batch: it aborts only when EVERY
 * live caller has aborted (a single caller cancelling must not kill the shared
 * query the others are still waiting on). When not every caller supplies a
 * signal, the batch is never collectively aborted.
 */
function combinedAbortController<R extends AbortableRequest>(live: R[]): AbortController {
  const controller = new AbortController();
  const signals = live.map((r) => r.signal).filter(Boolean) as AbortSignal[];
  if (signals.length > 0 && signals.length === live.length) {
    const checkAllAborted = () => {
      if (signals.every((s) => s.aborted)) controller.abort(signals[0].reason);
    };
    for (const sig of signals) sig.addEventListener('abort', checkAllAborted, { once: true });
  }
  return controller;
}

/**
 * Accumulates requests during the current microtask and fires a single combined
 * query once it drains. Subclasses implement `flush()` (the query + fan-out);
 * this base owns the pending queue and microtask scheduling shared by every
 * collector.
 */
abstract class MicrotaskBatcher<R extends AbortableRequest> {
  protected pending: R[] = [];
  private scheduled = false;

  /** Enqueue a request and schedule a flush for the end of this microtask. */
  protected enqueue(req: R): void {
    this.pending.push(req);
    if (!this.scheduled) {
      this.scheduled = true;
      queueMicrotask(() => this.flush());
    }
  }

  /** Drain the pending queue into `batch` and reset for the next tick. */
  protected drain(): R[] {
    const batch = this.pending;
    this.pending = [];
    this.scheduled = false;
    return batch;
  }

  protected abstract flush(): Promise<void>;
}

/**
 * A batch collector that accumulates requests during the current microtask
 * and then fires a single combined query.
 */
class BatchCollector<V> extends MicrotaskBatcher<PendingRequest<V>> {
  constructor(
    private executeBatch: (keys: string[], signal: AbortSignal) => Promise<Map<string, V>>,
  ) {
    super();
  }

  /** Enqueue a request. Returns a promise that resolves when the batch completes. */
  request(key: string, signal?: AbortSignal): Promise<V> {
    return new Promise<V>((resolve, reject) => {
      if (signal?.aborted) {
        reject(signal.reason);
        return;
      }
      this.enqueue({ key, resolve, reject, signal });
    });
  }

  /** Drain the pending queue and execute the batch. */
  protected async flush(): Promise<void> {
    const live = partitionLive(this.drain());
    if (live.length === 0) return;

    // Deduplicate keys.
    const uniqueKeys: string[] = [];
    const seen = new Set<string>();
    for (const req of live) {
      if (!seen.has(req.key)) {
        seen.add(req.key);
        uniqueKeys.push(req.key);
      }
    }

    const controller = combinedAbortController(live);

    try {
      // Chunk to respect relay limits.
      const allResults = new Map<string, V>();
      const chunks: string[][] = [];
      for (let i = 0; i < uniqueKeys.length; i += MAX_BATCH_SIZE) {
        chunks.push(uniqueKeys.slice(i, i + MAX_BATCH_SIZE));
      }

      await Promise.all(
        chunks.map(async (chunk) => {
          const results = await this.executeBatch(chunk, controller.signal);
          for (const [key, value] of results) {
            allResults.set(key, value);
          }
        }),
      );

      for (const req of live) {
        if (req.signal?.aborted) {
          req.reject(req.signal.reason);
        } else {
          req.resolve(allResults.get(req.key) as V);
        }
      }
    } catch (error) {
      for (const req of live) {
        req.reject(error);
      }
    }
  }
}

// --- Filter pattern detection ---

/** A filter that only fetches events by ID: `{ ids: [x], limit?: n }` */
function isIdsOnlyFilter(filter: NostrFilter): filter is { ids: string[]; limit?: number } {
  const keys = Object.keys(filter);
  return keys.every((k) => k === 'ids' || k === 'limit') && Array.isArray(filter.ids) && filter.ids.length === 1;
}

/**
 * Replaceable kinds that are fetched once per author and can be merged into a
 * single multi-kind query when multiple hooks request different kinds for the
 * same pubkey in the same microtask tick.
 */
const REPLACEABLE_KINDS = new Set([0, 3, 10000, 10001, 10002, 10003, 10015, 10030, 10063, 16767]);

/**
 * A filter that fetches a single replaceable event by author:
 * `{ kinds: [k], authors: [a], limit?: n }` where k is a known replaceable kind.
 */
function isReplaceableFilter(filter: NostrFilter): boolean {
  const keys = Object.keys(filter);
  return (
    keys.every((k) => k === 'kinds' || k === 'authors' || k === 'limit') &&
    filter.kinds?.length === 1 &&
    REPLACEABLE_KINDS.has(filter.kinds[0]) &&
    filter.authors?.length === 1 &&
    filter.limit !== undefined
  );
}

/**
 * Batches replaceable-kind queries by pubkey across a microtask window.
 *
 * When multiple hooks request different kinds for the same pubkey
 * (e.g. kind 0 from useAuthor, kind 3 from useFollowList, kind 10000 from
 * useMuteList), they are merged into one REQ:
 *   { kinds: [0, 3, 10000], authors: [pubkey], limit: 3 }
 *
 * Each caller still gets back only its own event (or undefined).
 */
class ReplaceableCollector extends MicrotaskBatcher<{
  pubkey: string;
  kind: number;
  resolve: (event: NostrEvent | undefined) => void;
  reject: (error: unknown) => void;
  signal?: AbortSignal;
}> {
  constructor(
    private pool: NPool,
  ) {
    super();
  }

  /**
   * Collect events for a replaceable-event filter, waiting longer than the
   * pool's global `eoseTimeout` so SLOW/COLD relays get a real chance to return
   * a profile. Replaceable events (kind 0, etc.) legitimately live on different
   * relays than the fastest one in the set, and the global 300ms post-EOSE
   * cutoff routinely drops them — that's the kind-0 "lag/cutoff". We stream via
   * `pool.req` with a generous per-call `eoseTimeout` and stop at the merged
   * EOSE (all relays done) or the grace window, whichever comes first.
   */
  private async collect(filter: NostrFilter, signal: AbortSignal): Promise<NostrEvent[]> {
    const events: NostrEvent[] = [];
    try {
      for await (const msg of this.pool.req([filter], { signal, eoseTimeout: PROFILE_EOSE_GRACE_MS })) {
        if (msg[0] === 'EVENT') events.push(msg[2]);
        else if (msg[0] === 'EOSE' || msg[0] === 'CLOSED') break;
      }
    } catch {
      // Aborted / relay error — return whatever arrived.
    }
    return events;
  }

  request(pubkey: string, kind: number, signal?: AbortSignal): Promise<NostrEvent | undefined> {
    return new Promise((resolve, reject) => {
      if (signal?.aborted) {
        reject(signal.reason);
        return;
      }
      this.enqueue({ pubkey, kind, resolve, reject, signal });
    });
  }

  protected async flush(): Promise<void> {
    const live = partitionLive(this.drain());
    if (live.length === 0) return;

    // Collect unique kinds per pubkey.
    const kindsByPubkey = new Map<string, Set<number>>();
    for (const { pubkey, kind } of live) {
      if (!kindsByPubkey.has(pubkey)) kindsByPubkey.set(pubkey, new Set());
      kindsByPubkey.get(pubkey)!.add(kind);
    }

    // Group pubkeys by their kind-set so pubkeys requesting the same kinds
    // (e.g. all NoteCard authors requesting only kind 0) are fetched in one REQ.
    const byKindSet = new Map<string, { kinds: number[]; pubkeys: string[] }>();
    for (const [pubkey, kinds] of kindsByPubkey) {
      const key = [...kinds].sort((a, b) => a - b).join(',');
      if (!byKindSet.has(key)) byKindSet.set(key, { kinds: [...kinds].sort((a, b) => a - b), pubkeys: [] });
      byKindSet.get(key)!.pubkeys.push(pubkey);
    }

    const controller = combinedAbortController(live);

    // results[pubkey][kind] = event | undefined
    const results = new Map<string, Map<number, NostrEvent | undefined>>();

    try {
      await Promise.all(
        [...byKindSet.values()].map(async ({ kinds, pubkeys }) => {
          const events = await this.collect(
            { kinds, authors: pubkeys, limit: kinds.length * pubkeys.length },
            controller.signal,
          );
          // Index by pubkey+kind, pick newest per pair.
          for (const pubkey of pubkeys) {
            if (!results.has(pubkey)) results.set(pubkey, new Map());
          }
          for (const event of events) {
            const kindMap = results.get(event.pubkey);
            if (!kindMap) continue;
            const existing = kindMap.get(event.kind);
            if (!existing || event.created_at > existing.created_at) {
              kindMap.set(event.kind, event);
            }
          }
        }),
      );
    } catch (error) {
      for (const r of live) r.reject(error);
      return;
    }

    // Retry kind 0 profiles not found in the initial query against the loser
    // relays. The relay race (eoseTimeout) resolves as soon as the first relay
    // sends EOSE, so slower relays may not have had time to return all profiles.
    // Collect the missing pubkeys and issue a second batched query so those
    // relays get a full chance to respond.
    const missingKind0Pubkeys = [...byKindSet.values()]
      .filter(({ kinds }) => kinds.includes(0))
      .flatMap(({ pubkeys }) => pubkeys)
      .filter((pubkey) => !results.get(pubkey)?.get(0));

    if (missingKind0Pubkeys.length > 0 && !controller.signal.aborted) {
      try {
        // Chunk into batches to respect relay filter limits.
        const chunks: string[][] = [];
        for (let i = 0; i < missingKind0Pubkeys.length; i += MAX_BATCH_SIZE) {
          chunks.push(missingKind0Pubkeys.slice(i, i + MAX_BATCH_SIZE));
        }

        await Promise.all(
          chunks.map(async (chunk) => {
            const retryEvents = await this.collect(
              { kinds: [0], authors: chunk, limit: chunk.length },
              controller.signal,
            );
            for (const event of retryEvents) {
              if (!results.has(event.pubkey)) results.set(event.pubkey, new Map());
              const kindMap = results.get(event.pubkey)!;
              const existing = kindMap.get(0);
              if (!existing || event.created_at > existing.created_at) {
                kindMap.set(0, event);
              }
            }
          }),
        );
      } catch {
        // Retry failure is non-fatal — callers still get the initial results.
      }
    }

    for (const r of live) {
      if (r.signal?.aborted) {
        r.reject(r.signal.reason);
      } else {
        r.resolve(results.get(r.pubkey)?.get(r.kind));
      }
    }
  }
}

/**
 * Batches addressable-event queries that share a fixed kind + `d` tag across
 * many AUTHORS in a microtask window. The motivating case is NIP-38 user
 * statuses (kind 30315, `d: "general"`): a member list mounts dozens of rows
 * that each want one author's status, and without batching that's one REQ per
 * member. This collector merges them into a single
 *   { kinds: [k], authors: [...], '#d': [d], limit: authors.length }
 * REQ and hands each caller back only its own author's event.
 *
 * Note this is the opposite axis from `dTagCollectors`/`executeDTagBatch`,
 * which batch many `d` tags for ONE author. Here the kind and `d` are fixed
 * and the authors vary.
 */
class FixedDTagAuthorCollector extends MicrotaskBatcher<{
  author: string;
  resolve: (event: NostrEvent | undefined) => void;
  reject: (error: unknown) => void;
  signal?: AbortSignal;
}> {
  constructor(
    private pool: NPool,
    private kind: number,
    private dTag: string,
  ) {
    super();
  }

  request(author: string, signal?: AbortSignal): Promise<NostrEvent | undefined> {
    return new Promise((resolve, reject) => {
      if (signal?.aborted) {
        reject(signal.reason);
        return;
      }
      this.enqueue({ author, resolve, reject, signal });
    });
  }

  protected async flush(): Promise<void> {
    const live = partitionLive(this.drain());
    if (live.length === 0) return;

    // Unique authors, preserving order.
    const authors: string[] = [];
    const seen = new Set<string>();
    for (const r of live) {
      if (!seen.has(r.author)) {
        seen.add(r.author);
        authors.push(r.author);
      }
    }

    const controller = combinedAbortController(live);

    const byAuthor = new Map<string, NostrEvent>();
    try {
      // Chunk authors to respect relay filter limits.
      const chunks: string[][] = [];
      for (let i = 0; i < authors.length; i += MAX_BATCH_SIZE) {
        chunks.push(authors.slice(i, i + MAX_BATCH_SIZE));
      }
      await Promise.all(
        chunks.map(async (chunk) => {
          const events = await this.pool.query(
            [{ kinds: [this.kind], authors: chunk, '#d': [this.dTag], limit: chunk.length }],
            { signal: controller.signal },
          );
          for (const event of events) {
            // Defensive: relays may return events that don't match the d-tag.
            const d = event.tags.find(([name]) => name === 'd')?.[1] ?? '';
            if (d !== this.dTag) continue;
            const existing = byAuthor.get(event.pubkey);
            if (!existing || event.created_at > existing.created_at) {
              byAuthor.set(event.pubkey, event);
            }
          }
        }),
      );
    } catch (error) {
      for (const r of live) r.reject(error);
      return;
    }

    for (const r of live) {
      if (r.signal?.aborted) {
        r.reject(r.signal.reason);
      } else {
        r.resolve(byAuthor.get(r.author));
      }
    }
  }
}

/** A filter for kind:7 reactions by a single author to a single event. */
function isReactionFilter(filter: NostrFilter): boolean {
  const keys = Object.keys(filter);
  return (
    keys.every((k) => k === 'kinds' || k === 'authors' || k === '#e' || k === 'limit') &&
    filter.kinds?.length === 1 &&
    filter.kinds[0] === 7 &&
    filter.authors?.length === 1 &&
    (filter as Record<string, unknown>)['#e'] !== undefined &&
    (Array.isArray((filter as Record<string, unknown>)['#e']) && ((filter as Record<string, unknown>)['#e'] as string[]).length === 1)
  );
}

/** A filter for kind:6/16 reposts by a single author to a single event. */
function isRepostFilter(filter: NostrFilter): boolean {
  const keys = Object.keys(filter);
  const kinds = filter.kinds;
  if (!kinds || kinds.length === 0) return false;
  const eTag = (filter as Record<string, unknown>)['#e'];
  return (
    keys.every((k) => k === 'kinds' || k === 'authors' || k === '#e' || k === 'limit') &&
    kinds.every((k) => k === 6 || k === 16) &&
    filter.authors?.length === 1 &&
    eTag !== undefined &&
    Array.isArray(eTag) &&
    (eTag as string[]).length === 1
  );
}

/**
 * A filter that queries by a single `#e` tag with kinds and limit.
 * e.g. `{ kinds: [7, 9735], '#e': [eventId], limit: 10 }`
 * Must NOT have `authors` (that's the reaction pattern).
 */
function isETagFilter(filter: NostrFilter): boolean {
  const keys = Object.keys(filter);
  return (
    keys.every((k) => k === 'kinds' || k === '#e' || k === 'limit') &&
    Array.isArray(filter.kinds) &&
    filter.kinds.length > 0 &&
    !filter.authors &&
    (filter as Record<string, unknown>)['#e'] !== undefined &&
    Array.isArray((filter as Record<string, unknown>)['#e']) &&
    ((filter as Record<string, unknown>)['#e'] as string[]).length === 1
  );
}

/**
 * Extract the single `#e` value from a filter known to have one.
 */
function getETagValue(filter: NostrFilter): string {
  return ((filter as Record<string, unknown>)['#e'] as string[])[0];
}

/**
 * Check if a multi-filter array can be batched: every filter must be an
 * e-tag or q-tag filter referencing the same single event ID.
 * e.g. [{ kinds: [7, 9735], '#e': [id], limit: 10 }, { kinds: [1], '#q': [id], limit: 5 }]
 */
function isMultiFilterETagBatchable(filters: NostrFilter[]): string | null {
  if (filters.length < 2) return null;
  let commonId: string | null = null;

  for (const filter of filters) {
    const keys = Object.keys(filter);
    // Each filter must only have kinds + (#e or #q) + optional limit
    const isEFilter = keys.every((k) => k === 'kinds' || k === '#e' || k === 'limit') &&
      (filter as Record<string, unknown>)['#e'] !== undefined &&
      Array.isArray((filter as Record<string, unknown>)['#e']) &&
      ((filter as Record<string, unknown>)['#e'] as string[]).length === 1;

    const isQFilter = keys.every((k) => k === 'kinds' || k === '#q' || k === 'limit') &&
      (filter as Record<string, unknown>)['#q'] !== undefined &&
      Array.isArray((filter as Record<string, unknown>)['#q']) &&
      ((filter as Record<string, unknown>)['#q'] as string[]).length === 1;

    if (!isEFilter && !isQFilter) return null;

    const id = isEFilter
      ? ((filter as Record<string, unknown>)['#e'] as string[])[0]
      : ((filter as Record<string, unknown>)['#q'] as string[])[0];

    if (commonId === null) {
      commonId = id;
    } else if (id !== commonId) {
      return null; // Different IDs, can't batch
    }
  }

  return commonId;
}

/**
 * Addressable kinds whose `{ kinds:[k], authors:[a], '#d':[d] }` queries should
 * batch across AUTHORS (one REQ for many users) rather than across `d` tags.
 * These are per-user singletons fetched for whole rosters at once — NIP-38 user
 * statuses (30315) are the canonical case.
 */
const AUTHOR_BATCHED_DTAG_KINDS = new Set([30315]);

/**
 * A fixed-kind, fixed-`d`-tag, single-author filter for a kind we batch across
 * authors: `{ kinds: [k], authors: [a], '#d': [d], limit?: n }` with
 * `k ∈ AUTHOR_BATCHED_DTAG_KINDS`.
 */
function isAuthorBatchedDTagFilter(filter: NostrFilter): boolean {
  const keys = Object.keys(filter);
  return (
    keys.every((k) => k === 'kinds' || k === 'authors' || k === '#d' || k === 'limit') &&
    filter.kinds?.length === 1 &&
    AUTHOR_BATCHED_DTAG_KINDS.has(filter.kinds[0]) &&
    filter.authors?.length === 1 &&
    (filter as Record<string, unknown>)['#d'] !== undefined &&
    Array.isArray((filter as Record<string, unknown>)['#d']) &&
    ((filter as Record<string, unknown>)['#d'] as string[]).length === 1
  );
}

/** A filter for addressable events by d-tag: `{ kinds: [k], authors: [a], '#d': [d], limit?: n }` */
function isDTagFilter(filter: NostrFilter): boolean {
  const keys = Object.keys(filter);
  return (
    keys.every((k) => k === 'kinds' || k === 'authors' || k === '#d' || k === 'limit') &&
    filter.kinds?.length === 1 &&
    filter.authors?.length === 1 &&
    (filter as Record<string, unknown>)['#d'] !== undefined &&
    (Array.isArray((filter as Record<string, unknown>)['#d']) && ((filter as Record<string, unknown>)['#d'] as string[]).length === 1)
  );
}

/** A `req` stream message tuple (EVENT / EOSE / CLOSED). */
type RelayMsg =
  | import('@nostrify/types').NostrRelayEVENT
  | import('@nostrify/types').NostrRelayEOSE
  | import('@nostrify/types').NostrRelayCLOSED;

/**
 * Stable key for coalescing identical `relay()`/`group()` traffic: the scope
 * (relay set) plus the filter set, order-insensitive. Two callers that produce
 * the same key are asking the same relays the same question, so their upstream
 * work can be shared. Filters are canonicalized by sorting their entries (and
 * each entry's array values) so key order / array order can't split a genuine
 * match into two.
 */
function coalesceKey(scopeRelays: string[], filters: NostrFilter[]): string {
  const norm = filters.map((f) => {
    const entries = Object.entries(f)
      .map(([k, v]) => [k, Array.isArray(v) ? [...v].sort() : v] as const)
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
    return JSON.stringify(entries);
  });
  return `${[...scopeRelays].sort().join(',')}|${norm.join('|')}`;
}

/**
 * A single upstream `req()` stream fanned out to N subscribers. The first
 * subscriber for a given key opens the upstream subscription; every later
 * subscriber with the same key attaches to it instead of opening its own
 * socket REQ. Each subscriber gets an independent async iterator that replays
 * nothing (live tail semantics — subscribers see messages from the moment they
 * attach) and drains only its own buffered messages. When the LAST subscriber
 * detaches (its consumer aborts or stops iterating), the upstream is aborted.
 *
 * This is what collapses the pageload's `⟳xN DUPLICATE` live subscriptions
 * (identical kind-1059 `since` REQs from the Concord/DM hooks) onto one socket.
 */
class SharedSubscription {
  private subscribers = new Set<Subscriber>();
  private controller = new AbortController();
  private closed = false;

  constructor(
    /**
     * Opens the upstream stream. Receives the subscription's own abort signal
     * so tearing the fan-out down (last subscriber left, pump closed) actually
     * CLOSEs the socket REQ — an upstream opened without a signal would stay
     * registered on the relay (and pumping) forever after a silent teardown.
     */
    source: (signal: AbortSignal) => AsyncIterable<RelayMsg>,
    private onEmpty: () => void,
    private onMessage: (msg: RelayMsg) => void,
  ) {
    void this.pump(source(this.controller.signal));
  }

  private async pump(source: AsyncIterable<RelayMsg>): Promise<void> {
    try {
      for await (const msg of source) {
        if (this.controller.signal.aborted) break;
        this.onMessage(msg);
        for (const sub of this.subscribers) sub.push(msg);
      }
    } catch {
      // Upstream ended/errored — fall through to close every subscriber.
    } finally {
      this.close();
    }
  }

  /** Close the upstream and finish every attached subscriber's iterator. */
  private close(): void {
    if (this.closed) return;
    this.closed = true;
    this.controller.abort();
    for (const sub of this.subscribers) sub.finish();
    this.subscribers.clear();
  }

  /** Whether new subscribers can still attach (false once the upstream ended). */
  isOpen(): boolean {
    return !this.closed;
  }

  /**
   * Attach a subscriber. Returns an async iterable of the live message stream;
   * aborting `signal` (or breaking out of the iteration) detaches it, and the
   * upstream is torn down once the last subscriber leaves.
   */
  subscribe(signal?: AbortSignal): AsyncIterable<RelayMsg> {
    const sub = new Subscriber();
    this.subscribers.add(sub);

    const detach = () => {
      if (!this.subscribers.delete(sub)) return;
      sub.finish();
      if (this.subscribers.size === 0) {
        this.controller.abort();
        this.onEmpty();
      }
    };

    if (signal) {
      if (signal.aborted) detach();
      else signal.addEventListener('abort', detach, { once: true });
    }

    const isClosed = () => this.closed;
    return {
      async *[Symbol.asyncIterator]() {
        try {
          if (isClosed()) return;
          yield* sub.drain();
        } finally {
          detach();
        }
      },
    };
  }
}

/**
 * A single fan-out subscriber: a bounded async queue an iterator drains. `push`
 * enqueues (waking a waiting `drain`), `finish` signals end-of-stream.
 */
class Subscriber {
  private queue: RelayMsg[] = [];
  private wake?: () => void;
  private done = false;

  push(msg: RelayMsg): void {
    if (this.done) return;
    this.queue.push(msg);
    this.wake?.();
  }

  finish(): void {
    this.done = true;
    this.wake?.();
  }

  async *drain(): AsyncGenerator<RelayMsg> {
    for (;;) {
      while (this.queue.length > 0) {
        yield this.queue.shift()!;
      }
      if (this.done) return;
      await new Promise<void>((resolve) => {
        this.wake = resolve;
      });
      this.wake = undefined;
    }
  }
}

/**
 * Transparent batching proxy for NPool.
 *
 * Wraps an NPool and intercepts `.query()` calls. When a query uses a
 * recognizable single-item filter pattern (fetch by ID, profile by pubkey,
 * reaction check, d-tag lookup), the request is held for a microtask.
 * If more queries with the same pattern arrive in the same frame, they're
 * combined into one REQ.
 *
 * The `relay()`/`group()` handles additionally COALESCE identical concurrent
 * `.query()`/`.req()` calls onto one upstream (see `wrapCaching`): the
 * high-volume Concord/DM paths fan out per-relay and re-fire the same filter
 * from several hooks at once, so without this the pageload issues the same
 * socket REQ many times over (the `⟳xN DUPLICATE` floods in the query log).
 *
 * All other methods (`.event()`, `.close()`) pass through directly.
 *
 * Client code doesn't need to know batching exists — it calls
 * `nostr.query([{ kinds: [0], authors: [pk], limit: 1 }])` as usual.
 */
export class NostrBatcher {
  /** Batches replaceable-kind queries by pubkey, merging kinds per pubkey into one REQ. */
  private replaceableCollector: ReplaceableCollector;
  private eventCollector: BatchCollector<NostrEvent | undefined>;
  /** Keyed by userPubkey so each user's reactions batch separately. */
  private reactionCollectors = new Map<string, BatchCollector<NostrEvent | undefined>>();
  /** Keyed by `${userPubkey}:${kindsKey}` so each user's reposts batch separately per kind set. */
  private repostCollectors = new Map<string, BatchCollector<NostrEvent | undefined>>();
  /** Keyed by `${kind}:${author}` for d-tag batching. */
  private dTagCollectors = new Map<string, BatchCollector<NostrEvent | undefined>>();
  /** Keyed by `${kind}:${dTag}` for author batching of fixed-d-tag addressable kinds (e.g. NIP-38 statuses). */
  private fixedDTagAuthorCollectors = new Map<string, FixedDTagAuthorCollector>();
  /** Keyed by sorted kinds string for #e-tag batching. Returns arrays. */
  private eTagCollectors = new Map<string, BatchCollector<NostrEvent[]>>();
  /** Keyed by serialized filter shapes for multi-filter #e/#q batching. */
  private multiFilterCollectors = new Map<string, BatchCollector<NostrEvent[]>>();

  /**
   * In-flight `relay()`/`group()` `.query()` calls, keyed by scope+filters, so
   * concurrent identical one-shot reads share one upstream request instead of
   * each opening its own socket REQ. Cleared when the shared request settles.
   */
  private inflightQueries = new Map<string, Promise<NostrEvent[]>>();

  /**
   * Live `relay()`/`group()` `.req()` subscriptions, keyed by scope+filters, so
   * concurrent identical live tails fan out from one upstream subscription (see
   * {@link SharedSubscription}). Removed when the last subscriber detaches.
   */
  private sharedSubs = new Map<string, SharedSubscription>();

  /**
   * Optional local cache. Every event that flows out of `.query()` / `.req()`
   * is written here so the rest of the app can read it back cache-first. The
   * store is a promise because IndexedDB opens asynchronously; we never block
   * a relay read on it.
   */
  private store?: Promise<NStore>;

  constructor(private pool: NPool, store?: Promise<NStore>) {
    this.store = store;
    this.replaceableCollector = new ReplaceableCollector(pool);
    this.eventCollector = new BatchCollector((ids, signal) =>
      this.executeEventBatch(ids, signal),
    );
  }

  /**
   * Persist events to the local cache (fire-and-forget). Called for every
   * event that flows out of `.query()` and `.req()`, so the cache mirrors
   * whatever the relays return without any caller having to opt in.
   *
   * Gift-wrap kinds (1059/21059) are NEVER cached: they are opaque ciphertext,
   * a waste of space in the shared `armada-events` store, and every Concord/DM
   * consumer that needs them persists the DECRYPTED rumor in its own store
   * instead. This is the single chokepoint every caching path flows through, so
   * blocking here guarantees no wrap can leak into the cache from any read.
   *
   * Failures are swallowed: the cache is a best-effort mirror, never on the
   * critical path of a relay read.
   */
  private cacheEvents(events: NostrEvent[]): void {
    if (!this.store) return;
    const cacheable = events.filter((event) => event.kind !== 1059 && event.kind !== 21059);
    if (cacheable.length === 0) return;
    void this.store
      .then((store) => Promise.all(cacheable.map((event) => store.event(event))))
      .catch(() => {
        // Best-effort cache; ignore write failures.
      });
  }

  /**
   * Proxy for `pool.query()`. Detects batchable filter patterns and
   * combines them; everything else passes through directly. Every event
   * returned (batched or not) is mirrored into the local cache.
   */
  async query(
    filters: NostrFilter[],
    opts?: { signal?: AbortSignal },
  ): Promise<NostrEvent[]> {
    const events = await this.queryInner(filters, opts);
    this.cacheEvents(events);
    return events;
  }

  /**
   * The actual query logic. Detects batchable filter patterns and combines
   * them; everything else passes through directly to the pool.
   */
  private async queryInner(
    filters: NostrFilter[],
    opts?: { signal?: AbortSignal },
  ): Promise<NostrEvent[]> {
    // Only batch single-filter queries with recognized patterns.
    if (filters.length === 1) {
      const filter = filters[0];

      // { ids: [singleId] }
      if (isIdsOnlyFilter(filter)) {
        const event = await this.eventCollector.request(filter.ids[0], opts?.signal);
        return event ? [event] : [];
      }

      // { kinds: [replaceableKind], authors: [singlePubkey] }
      if (isReplaceableFilter(filter)) {
        const event = await this.replaceableCollector.request(filter.authors![0], filter.kinds![0], opts?.signal);
        return event ? [event] : [];
      }

      // { kinds: [7], authors: [user], '#e': [eventId] }
      if (isReactionFilter(filter)) {
        const userPubkey = filter.authors![0];
        const eventId = ((filter as Record<string, unknown>)['#e'] as string[])[0];
        let collector = this.reactionCollectors.get(userPubkey);
        if (!collector) {
          collector = new BatchCollector((eventIds, signal) =>
            this.executeReactionBatch(userPubkey, eventIds, signal),
          );
          this.reactionCollectors.set(userPubkey, collector);
        }
        const event = await collector.request(eventId, opts?.signal);
        return event ? [event] : [];
      }

      // { kinds: [6, 16], authors: [user], '#e': [eventId] }
      if (isRepostFilter(filter)) {
        const userPubkey = filter.authors![0];
        const eventId = ((filter as Record<string, unknown>)['#e'] as string[])[0];
        const kindsKey = [...filter.kinds!].sort().join(',');
        const collectorKey = `${userPubkey}:${kindsKey}`;
        let collector = this.repostCollectors.get(collectorKey);
        if (!collector) {
          collector = new BatchCollector((eventIds, signal) =>
            this.executeRepostBatch(userPubkey, filter.kinds!, eventIds, signal),
          );
          this.repostCollectors.set(collectorKey, collector);
        }
        const event = await collector.request(eventId, opts?.signal);
        return event ? [event] : [];
      }

      // { kinds: [...], '#e': [eventId] } (no authors — not a reaction check)
      if (isETagFilter(filter)) {
        const eventId = getETagValue(filter);
        const kindsKey = [...filter.kinds!].sort().join(',');
        const limit = filter.limit ?? 50;
        const collectorKey = `${kindsKey}:${limit}`;
        let collector = this.eTagCollectors.get(collectorKey);
        if (!collector) {
          collector = new BatchCollector((eventIds, signal) =>
            this.executeETagBatch(filter.kinds!, eventIds, limit, signal),
          );
          this.eTagCollectors.set(collectorKey, collector);
        }
        return collector.request(eventId, opts?.signal);
      }

      // { kinds: [30315], authors: [a], '#d': [d] } — batch across authors.
      // Must precede the generic d-tag check (same shape, different axis).
      if (isAuthorBatchedDTagFilter(filter)) {
        const kind = filter.kinds![0];
        const author = filter.authors![0];
        const dTag = ((filter as Record<string, unknown>)['#d'] as string[])[0];
        const collectorKey = `${kind}:${dTag}`;
        let collector = this.fixedDTagAuthorCollectors.get(collectorKey);
        if (!collector) {
          collector = new FixedDTagAuthorCollector(this.pool, kind, dTag);
          this.fixedDTagAuthorCollectors.set(collectorKey, collector);
        }
        const event = await collector.request(author, opts?.signal);
        return event ? [event] : [];
      }

      // { kinds: [k], authors: [a], '#d': [d] }
      if (isDTagFilter(filter)) {
        const kind = filter.kinds![0];
        const author = filter.authors![0];
        const dTag = ((filter as Record<string, unknown>)['#d'] as string[])[0];
        const collectorKey = `${kind}:${author}`;
        let collector = this.dTagCollectors.get(collectorKey);
        if (!collector) {
          collector = new BatchCollector((dTags, signal) =>
            this.executeDTagBatch(kind, author, dTags, signal),
          );
          this.dTagCollectors.set(collectorKey, collector);
        }
        const event = await collector.request(dTag, opts?.signal);
        return event ? [event] : [];
      }
    }

    // Multi-filter: check if all filters reference the same #e/#q event ID
    const multiFilterEventId = isMultiFilterETagBatchable(filters);
    if (multiFilterEventId !== null) {
      // Serialize the filter "shape" (kinds, tag names, limits) to get a collector key.
      // Multi-filter queries with the same shape are batched together.
      const shapeKey = filters.map((f) => {
        const keys = Object.keys(f).sort();
        return keys.map((k) => k === '#e' || k === '#q' ? k : `${k}:${JSON.stringify((f as Record<string, unknown>)[k])}`).join('|');
      }).join(';;');

      let collector = this.multiFilterCollectors.get(shapeKey);
      if (!collector) {
        collector = new BatchCollector((eventIds, signal) =>
          this.executeMultiFilterBatch(filters, eventIds, signal),
        );
        this.multiFilterCollectors.set(shapeKey, collector);
      }
      return collector.request(multiFilterEventId, opts?.signal);
    }

    // Not batchable — pass through directly.
    return this.pool.query(filters, opts);
  }

  // --- Pass-through methods ---

  event(event: NostrEvent, opts?: { signal?: AbortSignal }): Promise<void> {
    return this.pool.event(event, opts);
  }

  req(
    filters: NostrFilter[],
    opts?: { signal?: AbortSignal; eoseTimeout?: number },
  ): AsyncIterable<import('@nostrify/types').NostrRelayEVENT | import('@nostrify/types').NostrRelayEOSE | import('@nostrify/types').NostrRelayCLOSED> {
    const source = this.pool.req(filters, opts);
    const cacheEvents = this.cacheEvents.bind(this);
    // Wrap the stream so each EVENT message is mirrored into the cache as it
    // streams past, without altering what the consumer sees.
    return (async function* () {
      for await (const msg of source) {
        if (msg[0] === 'EVENT') {
          cacheEvents([msg[2]]);
        }
        yield msg;
      }
    })();
  }

  relay(url: string) {
    return this.wrapCaching(this.pool.relay(url), url);
  }

  group(urls: string[]) {
    return this.wrapCaching(this.pool.group(urls), undefined, urls);
  }

  /**
   * Record which relay served the channel-directory (kind-39000) events, so the
   * directory cache can be scoped by relay URL. This is the only reliable way to
   * isolate relays that share a signing key (e.g. zooid's shared relay identity,
   * where two servers advertise the same NIP-11 `self`/`pubkey`). No-op unless
   * the events came from a single known relay (`relay(url)`, not `group()`).
   */
  private recordDirectoryProvenance(events: NostrEvent[], sourceUrl: string | undefined): void {
    if (!sourceUrl) return;
    const ids = events.filter((e) => e.kind === KIND_GROUP_METADATA).map((e) => e.id);
    if (ids.length === 0) return;
    void recordRelayProvenanceBatch(ids, sourceUrl).catch(() => {
      // best-effort
    });
  }

  /**
   * Wrap a relay/group handle so its `.query()` and `.req()` output is mirrored
   * into the local cache, exactly like the pool-level `.query()`/`.req()` above.
   *
   * Group-scoped traffic (NIP-29 via `relay(url)`, DMs/Concord via `group()`)
   * bypasses the pool, so without this wrapper those events would never be
   * persisted — and chat history could not be read back from IndexedDB after a
   * refresh. The wrapper is transparent: callers see the same NRelay interface
   * and the same results; caching is fire-and-forget on the side.
   *
   * When `sourceUrl` is given (the single-relay `relay(url)` path), directory
   * events are additionally tagged with that relay's provenance. When
   * `groupUrls` is given (the `group(urls)` path), it's the actual relay set the
   * group fans out to — used only for the query log so `group` REQs report their
   * real relay count instead of "0 relays".
   */
  private wrapCaching<R extends NRelayLike>(relay: R, sourceUrl?: string, groupUrls?: string[]): R {
    // How this handle is scoped, for the query log ("relay(url)" vs "group(N)").
    const via = sourceUrl ? `relay(${sourceUrl})` : `group(${groupUrls?.length ?? 0})`;
    const scopeRelays = sourceUrl ? [sourceUrl] : (groupUrls ?? []);
    const coalescedQuery = this.coalescedQuery.bind(this);
    const coalescedReq = this.coalescedReq.bind(this);
    return new Proxy(relay, {
      get(target, prop, receiver) {
        if (prop === 'query') {
          return (filters: NostrFilter[], opts?: { signal?: AbortSignal }) =>
            coalescedQuery(target, via, scopeRelays, sourceUrl, filters, opts);
        }
        if (prop === 'req') {
          return (filters: NostrFilter[], opts?: { signal?: AbortSignal }) =>
            coalescedReq(target, via, scopeRelays, sourceUrl, filters, opts);
        }
        const value = Reflect.get(target, prop, receiver);
        return typeof value === 'function' ? value.bind(target) : value;
      },
    });
  }

  /**
   * `relay()`/`group()` `.query()` with in-flight coalescing: concurrent
   * identical reads (same scope + filters) share one upstream request. Only the
   * FIRST caller logs a REQ and drives the network; the rest await the shared
   * promise (so the query log — and the wire — sees one REQ, not N). Each caller
   * still honours its own `signal`: aborting one rejects only that caller and
   * never cancels the shared request the others are waiting on. Results are
   * cached/provenance-tagged once, on the shared path.
   */
  private coalescedQuery(
    target: NRelayLike,
    via: string,
    scopeRelays: string[],
    sourceUrl: string | undefined,
    filters: NostrFilter[],
    opts?: { signal?: AbortSignal },
  ): Promise<NostrEvent[]> {
    const key = `${via}::${coalesceKey(scopeRelays, filters)}`;
    let shared = this.inflightQueries.get(key);
    if (!shared) {
      logNostrReq(scopeRelays, filters, via);
      // Drive the shared request WITHOUT any caller signal, so one caller
      // aborting can't cancel it for the others. Per-caller abort is applied
      // below by racing each caller against its own signal. The deadline is
      // the shared request's ONLY signal: a query that never settles must not
      // park in `inflightQueries` forever and absorb every future identical
      // query (see SHARED_QUERY_DEADLINE_MS).
      shared = target
        .query(filters, { signal: AbortSignal.timeout(SHARED_QUERY_DEADLINE_MS) })
        .then((events) => {
          this.cacheEvents(events);
          this.recordDirectoryProvenance(events, sourceUrl);
          return events;
        })
        .finally(() => {
          this.inflightQueries.delete(key);
        });
      this.inflightQueries.set(key, shared);
    }

    const signal = opts?.signal;
    if (!signal) return shared;
    if (signal.aborted) return Promise.reject(signal.reason);
    // Race the shared result against this caller's own cancellation.
    return new Promise<NostrEvent[]>((resolve, reject) => {
      const onAbort = () => reject(signal.reason);
      signal.addEventListener('abort', onAbort, { once: true });
      shared.then(
        (events) => {
          signal.removeEventListener('abort', onAbort);
          resolve(events);
        },
        (err) => {
          signal.removeEventListener('abort', onAbort);
          reject(err);
        },
      );
    });
  }

  /**
   * `relay()`/`group()` `.req()` with subscription multiplexing: concurrent
   * identical live tails (same scope + filters) fan out from one upstream
   * subscription instead of each opening its own socket REQ. Only the first
   * subscriber logs a REQ and opens the upstream; the rest attach to it. Each
   * EVENT is cached once (on the shared upstream) and delivered to every
   * subscriber. The upstream is torn down when the last subscriber detaches.
   */
  private coalescedReq(
    target: NRelayLike,
    via: string,
    scopeRelays: string[],
    sourceUrl: string | undefined,
    filters: NostrFilter[],
    opts?: { signal?: AbortSignal },
  ): AsyncIterable<RelayMsg> {
    const key = `${via}::${coalesceKey(scopeRelays, filters)}`;
    let shared = this.sharedSubs.get(key);
    if (!shared || !shared.isOpen()) {
      logNostrReq(scopeRelays, filters, via);
      const sharedSubs = this.sharedSubs;
      const sub: SharedSubscription = new SharedSubscription(
        (signal) => target.req(filters, { signal }) as AsyncIterable<RelayMsg>,
        () => {
          // Last subscriber left — drop the entry so the next caller reopens.
          if (sharedSubs.get(key) === sub) sharedSubs.delete(key);
        },
        (msg) => {
          if (msg[0] === 'EVENT') {
            this.cacheEvents([msg[2]]);
            this.recordDirectoryProvenance([msg[2]], sourceUrl);
          }
        },
      );
      shared = sub;
      this.sharedSubs.set(key, sub);
    }
    return shared.subscribe(opts?.signal);
  }

  close(): Promise<void> {
    return this.pool.close();
  }

  // --- Batch executors ---

  private async executeRepostBatch(
    userPubkey: string,
    kinds: number[],
    eventIds: string[],
    signal: AbortSignal,
  ): Promise<Map<string, NostrEvent | undefined>> {
    const results = new Map<string, NostrEvent | undefined>();
    try {
      const events = await this.pool.query(
        [{ kinds, authors: [userPubkey], '#e': eventIds, limit: eventIds.length }],
        { signal },
      );
      const repostMap = new Map<string, NostrEvent>();
      for (const event of events) {
        const eTag = event.tags.find(([name]) => name === 'e')?.[1];
        if (!eTag) continue;
        const existing = repostMap.get(eTag);
        if (!existing || event.created_at > existing.created_at) {
          repostMap.set(eTag, event);
        }
      }
      for (const eventId of eventIds) {
        results.set(eventId, repostMap.get(eventId));
      }
    } catch {
      for (const eventId of eventIds) {
        results.set(eventId, undefined);
      }
    }
    return results;
  }

  private async executeEventBatch(
    ids: string[],
    signal: AbortSignal,
  ): Promise<Map<string, NostrEvent | undefined>> {
    const results = new Map<string, NostrEvent | undefined>();
    try {
      const events = await this.pool.query(
        [{ ids, limit: ids.length }],
        { signal },
      );
      const byId = new Map<string, NostrEvent>();
      for (const event of events) {
        byId.set(event.id, event);
      }
      for (const id of ids) {
        results.set(id, byId.get(id));
      }
    } catch {
      for (const id of ids) {
        results.set(id, undefined);
      }
    }
    return results;
  }

  private async executeReactionBatch(
    userPubkey: string,
    eventIds: string[],
    signal: AbortSignal,
  ): Promise<Map<string, NostrEvent | undefined>> {
    const results = new Map<string, NostrEvent | undefined>();
    try {
      const events = await this.pool.query(
        [{ kinds: [7], authors: [userPubkey], '#e': eventIds, limit: eventIds.length }],
        { signal },
      );
      const reactionMap = new Map<string, NostrEvent>();
      for (const event of events) {
        const eTag = event.tags.findLast(([name]) => name === 'e')?.[1];
        if (!eTag) continue;
        const existing = reactionMap.get(eTag);
        if (!existing || event.created_at > existing.created_at) {
          reactionMap.set(eTag, event);
        }
      }
      for (const eventId of eventIds) {
        results.set(eventId, reactionMap.get(eventId));
      }
    } catch {
      for (const eventId of eventIds) {
        results.set(eventId, undefined);
      }
    }
    return results;
  }

  private async executeDTagBatch(
    kind: number,
    author: string,
    dTags: string[],
    signal: AbortSignal,
  ): Promise<Map<string, NostrEvent | undefined>> {
    const results = new Map<string, NostrEvent | undefined>();
    try {
      const events = await this.pool.query(
        [{ kinds: [kind], authors: [author], '#d': dTags, limit: dTags.length }],
        { signal },
      );
      const byDTag = new Map<string, NostrEvent>();
      for (const event of events) {
        const d = event.tags.find(([name]) => name === 'd')?.[1];
        if (!d) continue;
        const existing = byDTag.get(d);
        if (!existing || event.created_at > existing.created_at) {
          byDTag.set(d, event);
        }
      }
      for (const dTag of dTags) {
        results.set(dTag, byDTag.get(dTag));
      }
    } catch {
      for (const dTag of dTags) {
        results.set(dTag, undefined);
      }
    }
    return results;
  }

  private async executeETagBatch(
    kinds: number[],
    eventIds: string[],
    perEventLimit: number,
    signal: AbortSignal,
  ): Promise<Map<string, NostrEvent[]>> {
    const results = new Map<string, NostrEvent[]>();
    try {
      const events = await this.pool.query(
        [{ kinds, '#e': eventIds, limit: eventIds.length * perEventLimit }],
        { signal },
      );

      // Group results by which event ID they reference via e-tag.
      const byEventId = new Map<string, NostrEvent[]>();
      const eventIdSet = new Set(eventIds);
      for (const event of events) {
        for (const tag of event.tags) {
          if (tag[0] === 'e' && eventIdSet.has(tag[1])) {
            const existing = byEventId.get(tag[1]) ?? [];
            existing.push(event);
            byEventId.set(tag[1], existing);
          }
        }
      }

      for (const eventId of eventIds) {
        results.set(eventId, byEventId.get(eventId) ?? []);
      }
    } catch {
      for (const eventId of eventIds) {
        results.set(eventId, []);
      }
    }
    return results;
  }

  private async executeMultiFilterBatch(
    templateFilters: NostrFilter[],
    eventIds: string[],
    signal: AbortSignal,
  ): Promise<Map<string, NostrEvent[]>> {
    const results = new Map<string, NostrEvent[]>();
    try {
      // Build combined filters by replacing single #e/#q values with the full batch.
      const batchedFilters: NostrFilter[] = templateFilters.map((f) => {
        const clone = { ...f };
        const rec = clone as Record<string, unknown>;
        if (rec['#e'] !== undefined) {
          rec['#e'] = eventIds;
          // Scale up limit proportionally
          if (clone.limit) {
            clone.limit = clone.limit * eventIds.length;
          }
        }
        if (rec['#q'] !== undefined) {
          rec['#q'] = eventIds;
          if (clone.limit) {
            clone.limit = clone.limit * eventIds.length;
          }
        }
        return clone;
      });

      const events = await this.pool.query(batchedFilters, { signal });

      // Group results by which event ID they reference via e-tag or q-tag.
      const byEventId = new Map<string, NostrEvent[]>();
      const eventIdSet = new Set(eventIds);

      for (const event of events) {
        const matchedIds = new Set<string>();
        for (const tag of event.tags) {
          if ((tag[0] === 'e' || tag[0] === 'q') && eventIdSet.has(tag[1])) {
            matchedIds.add(tag[1]);
          }
        }
        for (const id of matchedIds) {
          const existing = byEventId.get(id) ?? [];
          existing.push(event);
          byEventId.set(id, existing);
        }
      }

      for (const eventId of eventIds) {
        results.set(eventId, byEventId.get(eventId) ?? []);
      }
    } catch {
      for (const eventId of eventIds) {
        results.set(eventId, []);
      }
    }
    return results;
  }
}
