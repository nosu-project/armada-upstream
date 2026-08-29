/**
 * The worker pool behind {@link verifyCache}'s {@link EcVerifyBatch} seam.
 *
 * Schnorr verify was ~28% of GeckoMain's inclusive CPU during sync (profiled),
 * all on the main thread, and it is first-time-necessary work the memo can't
 * erase — only parallelism can. This spreads the EC verify of a decode batch
 * across a small pool of `verify.worker.ts` module workers, keeping the main
 * thread free to paint while a cold backfill's signatures are checked off it.
 *
 * The pool does the EC ONLY: `verifyCache.ts`'s `hashGate` has already bound
 * every id to the copy in hand and consulted the memo on the MAIN thread, so
 * what reaches a worker is a pre-hashed `(sig, id, pubkey)` triple it cannot be
 * tricked by. See `verify.worker.ts`.
 *
 * Two escape hatches keep this from ever being worse than the old inline path:
 *
 *  - **No `Worker`** (SSR, a locked-down runtime, a CSP that forbids the
 *    blob/module worker): construction is attempted ONCE, and any failure pins
 *    the pool "unavailable" so every batch runs inline forever after.
 *  - **A small batch** isn't worth a round trip: below {@link INLINE_THRESHOLD}
 *    triples, the fixed postMessage + structured-clone cost dominates the
 *    handful of verifies it would parallelize, so those run inline too. This is
 *    the common live-delivery case (a message or two at a time); the pool is for
 *    the backfill.
 */

import { schnorr } from "@noble/curves/secp256k1.js";
import { hexToBytes } from "@noble/hashes/utils.js";

import type { EcVerifyBatch, VerifyTriple } from "./verifyCache";
import type { VerifyRequest, VerifyResponse } from "./verifyWorkerTypes";

/**
 * How many triples a batch must have before the pool is worth using. Below it,
 * the round trip costs more than the verifies it parallelizes (measured: a
 * warm round is ~1ms of fixed overhead against ~1.8ms/verify on desktop, more
 * on a phone), so a small live delivery stays inline.
 */
const INLINE_THRESHOLD = 24;

/**
 * Worker ceiling: a couple of cores fewer than the machine has, capped small.
 * The pool exists to keep the UI thread free, not to saturate every core — a
 * backfill decode competes with nothing else that matters, and leaving cores
 * for the compositor/renderer is what keeps scroll smooth while it runs.
 */
function poolSize(): number {
  const cores = (typeof navigator !== "undefined" && navigator.hardwareConcurrency) || 4;
  return Math.max(1, Math.min(4, cores - 1));
}

/** One triple, inline. Any malformed hex reads as invalid, never as a throw. */
function verifyOneInline(t: VerifyTriple): boolean {
  try {
    return schnorr.verify(hexToBytes(t.sig), hexToBytes(t.id), hexToBytes(t.pubkey));
  } catch {
    return false;
  }
}

/** The whole batch on this thread — the fallback and the small-batch path. */
function verifyInline(triples: VerifyTriple[]): boolean[] {
  return triples.map(verifyOneInline);
}

/** A worker plus the replies it still owes, keyed by round id. */
interface PoolWorker {
  worker: Worker;
  pending: Map<number, (results: boolean[]) => void>;
}

/**
 * The pool, built at most once. `undefined` = not yet attempted; `null` =
 * attempted and unavailable (always inline); an array = live workers.
 */
let pool: PoolWorker[] | null | undefined;
let nextRoundId = 0;

/** Build the pool once; pin it `null` (inline forever) if `Worker` can't run. */
function ensurePool(): PoolWorker[] | null {
  if (pool !== undefined) return pool;
  if (typeof Worker === "undefined") {
    pool = null;
    return null;
  }
  try {
    pool = Array.from({ length: poolSize() }, () => {
      const worker = new Worker(new URL("./verify.worker.ts", import.meta.url), { type: "module" });
      const entry: PoolWorker = { worker, pending: new Map() };
      worker.onmessage = (event: MessageEvent<VerifyResponse>) => {
        const { id, results } = event.data;
        const settle = entry.pending.get(id);
        if (settle) {
          entry.pending.delete(id);
          settle(results);
        }
      };
      // A worker that dies mid-flight resolves its debts as "unverified" rather
      // than hanging the decode: the caller drops those events, exactly as a
      // bad signature would, and the honest copies are refetchable.
      worker.onerror = () => {
        for (const settle of entry.pending.values()) settle([]);
        entry.pending.clear();
      };
      return entry;
    });
    return pool;
  } catch {
    // Construction refused (CSP, exotic runtime): inline from here on.
    pool = null;
    return null;
  }
}

/** One chunk to one worker, resolving when its tagged reply returns. */
function dispatch(entry: PoolWorker, triples: VerifyTriple[]): Promise<boolean[]> {
  const id = nextRoundId++;
  const request: VerifyRequest = { id, triples };
  return new Promise<boolean[]>((resolve) => {
    entry.pending.set(id, resolve);
    try {
      entry.worker.postMessage(request);
    } catch {
      // The worker won't answer — resolve as "unverified" (dropped, refetchable)
      // rather than leaving the decode awaiting a reply that never comes.
      entry.pending.delete(id);
      resolve([]);
    }
  });
}

/**
 * The {@link EcVerifyBatch} the app hands `verifyEventsOnce`: split the residue
 * across the pool, one contiguous chunk per worker, and stitch the per-worker
 * answers back into one array in the caller's order.
 *
 * A chunk that comes back short (a worker that errored resolves `[]`) is padded
 * with `false`, so the result is always one boolean per input triple — a
 * missing verify reads as "unverified", never as a hole the caller would index
 * past.
 */
export const ecVerifyBatch: EcVerifyBatch = async (triples: VerifyTriple[]): Promise<boolean[]> => {
  if (triples.length === 0) return [];

  const workers = ensurePool();
  if (!workers || triples.length < INLINE_THRESHOLD) {
    return verifyInline(triples);
  }

  // Contiguous chunks, one per worker; the last takes the remainder.
  const chunkSize = Math.ceil(triples.length / workers.length);
  const chunks: VerifyTriple[][] = [];
  for (let i = 0; i < triples.length; i += chunkSize) {
    chunks.push(triples.slice(i, i + chunkSize));
  }

  const parts = await Promise.all(chunks.map((chunk, i) => dispatch(workers[i], chunk)));

  const out: boolean[] = [];
  for (let c = 0; c < chunks.length; c++) {
    const answered = parts[c];
    for (let j = 0; j < chunks[c].length; j++) out.push(answered[j] === true);
  }
  return out;
};

/** Test seam: tear the pool down and forget it (a fresh test rebuilds it). */
export function _resetVerifyPoolForTests(): void {
  if (Array.isArray(pool)) for (const entry of pool) entry.worker.terminate();
  pool = undefined;
  nextRoundId = 0;
}
