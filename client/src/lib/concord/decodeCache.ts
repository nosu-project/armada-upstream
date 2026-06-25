/**
 * Decode-once memo for Concord's sealed outer events.
 *
 * Opening a sealed outer is the expensive step: a NIP-44 decrypt, a JSON parse,
 * and a Schnorr `verifyEvent` per event. The local event store (NIndexedDB,
 * `armada-events`) is append-only and accumulates every sealed blob ever seen,
 * so the read path re-reads the same blobs on every load, poll, and reconnect —
 * and re-verifying them all, serially, on the main thread is what makes a busy
 * channel "sit forever" decrypting its whole queue.
 *
 * Vector avoids this by decrypting each gift-wrap exactly once and persisting
 * the plaintext (`wrapper_event_exists` skips a re-delivered wrapper before any
 * crypto). We keep the same property in-process: each outer wire event is keyed
 * by its `id` (the `wrapperId`); once opened, the result (or the fact that it's
 * undecodable) is memoized, so re-reading the store is just map lookups.
 *
 * The memo is keyed by `wrapperId` (the outer event id) which already binds the
 * channel/epoch/author triad through the verified inner — there is no risk of a
 * stale result surviving a rekey because a new epoch produces new outer events
 * with new ids. The cache lives for the page session (it is not persisted): the
 * persistence is the sealed blobs in IndexedDB; this just stops us paying the
 * verify cost twice for the same blob within a session.
 */

import { openMessageMulti, type OpenedMessage } from "@/lib/concord/envelope";

import type { NostrEvent } from "@nostrify/nostrify";

/** A successful open (`opened`) or a remembered failure (`undefined`). */
type DecodeResult = OpenedMessage | undefined;

/**
 * wrapperId → decode result. A `Map` entry's presence means "already attempted";
 * the value distinguishes a decoded message from a remembered skip (not ours /
 * bad-sig / no-held-epoch), so neither is re-verified.
 */
const memo = new Map<string, DecodeResult>();

/** Yield to the event loop so a long decode batch never blocks paint/input. */
function yieldToEventLoop(): Promise<void> {
  return new Promise((resolve) => {
    if (typeof requestIdleCallback === "function") {
      requestIdleCallback(() => resolve(), { timeout: 50 });
    } else {
      setTimeout(resolve, 0);
    }
  });
}

/**
 * Open a single sealed outer, memoized by its wrapper id. The first call for a
 * given outer pays the NIP-44-decrypt + verify cost; subsequent calls (a poll,
 * a reconnect re-forward, the next page load within the session) are a map hit.
 * Returns `undefined` for an outer that isn't ours / doesn't verify under any
 * held epoch — and remembers that, so it isn't retried until `allEpochKeys`
 * grows (a caught-up rekey), which the caller signals via {@link forgetSkips}.
 */
export function openMemoized(
  outer: NostrEvent,
  channelId: Uint8Array,
  epochKeys: Array<{ epoch: bigint; key: Uint8Array }>,
): DecodeResult {
  const cached = memo.get(outer.id);
  if (cached !== undefined || memo.has(outer.id)) return cached;
  let opened: DecodeResult;
  try {
    opened = openMessageMulti(outer, channelId, epochKeys);
  } catch {
    opened = undefined; // not ours / bad-sig / no-held-epoch
  }
  memo.set(outer.id, opened);
  return opened;
}

/**
 * Drop remembered *failures* so the next decode pass retries them under a
 * (now larger) set of epoch keys. Called when a rekey is caught up: blobs that
 * were `no-held-epoch` skips may now decode. Successfully-decoded entries are
 * kept — their result can't change.
 */
export function forgetSkips(): void {
  for (const [id, result] of memo) {
    if (result === undefined) memo.delete(id);
  }
}

/**
 * Open a batch of sealed outers without blocking the main thread: decode in
 * chunks, yielding to the event loop between chunks so the UI stays responsive
 * even when first-decoding a large backlog. Each outer is opened via
 * {@link openMemoized}, so a re-read of already-seen blobs returns near-instantly
 * (pure map lookups, no crypto). `signal` aborts a long decode (e.g. the channel
 * was switched away). Returns successfully-opened messages only, in input order.
 */
export async function openMemoizedBatch(
  events: NostrEvent[],
  channelId: Uint8Array,
  epochKeys: Array<{ epoch: bigint; key: Uint8Array }>,
  opts?: { signal?: AbortSignal; chunkSize?: number },
): Promise<OpenedMessage[]> {
  const chunkSize = opts?.chunkSize ?? 64;
  const out: OpenedMessage[] = [];
  for (let i = 0; i < events.length; i++) {
    if (opts?.signal?.aborted) break;
    const opened = openMemoized(events[i], channelId, epochKeys);
    if (opened) out.push(opened);
    // Yield only at chunk boundaries, and only when there's a genuine decode
    // cost to amortise — a fully-memoized re-read flies through with no yields.
    if ((i + 1) % chunkSize === 0) await yieldToEventLoop();
  }
  return out;
}
