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
 * Failure never changes an ANSWER, only where it is computed. A worker that
 * errors, or whose channel throws, hands its chunk back to this thread — a
 * missing reply must not read as "forged", because callers (`openChatBatch`)
 * memoize a false verdict per wrap and a transient worker death would poison
 * good messages for the session. An errored worker is marked dead and never
 * dispatched to again: a message posted to a dead worker vanishes without an
 * error, so re-using it would leave a batch awaiting a reply that can never
 * come. Two more paths keep the pool from ever being worse than inline:
 *
 *  - **No `Worker`** (SSR, a locked-down runtime, a CSP that forbids the
 *    blob/module worker): construction is attempted ONCE, and any failure pins
 *    the pool "unavailable" so every batch runs inline forever after.
 *  - **A small batch** isn't worth a round trip: below {@link INLINE_THRESHOLD}
 *    triples, the fixed postMessage + structured-clone cost dominates the
 *    handful of verifies it would parallelize, so those run inline too. This is
 *    the common live-delivery case (a message or two at a time); the pool is for
 *    the backfill.
 *
 * The inline path itself is time-sliced ({@link INLINE_SLICE_MS}): it runs on
 * the main thread precisely when the pool can't, and an unsliced loop over a
 * batch of ~ms-each EC verifies is the jank the pool exists to remove.
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
 * How long an inline slice may run before yielding — matches `openChatBatch`'s
 * decode slice, since the inline verify runs interleaved with that loop's
 * budget on the same thread.
 */
const INLINE_SLICE_MS = 5;

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

/**
 * A batch on this thread — the fallback and the small-batch path — sliced so
 * the main thread keeps painting while it runs. Each verify is milliseconds,
 * so the yield check runs per triple rather than per group.
 */
async function verifyInline(triples: VerifyTriple[]): Promise<boolean[]> {
  const out = new Array<boolean>(triples.length);
  let sliceStart = performance.now();
  for (let i = 0; i < triples.length; i++) {
    out[i] = verifyOneInline(triples[i]);
    if (i + 1 < triples.length && performance.now() - sliceStart >= INLINE_SLICE_MS) {
      await new Promise((resolve) => setTimeout(resolve, 0));
      sliceStart = performance.now();
    }
  }
  return out;
}

/** A worker plus the replies it still owes, keyed by round id. */
interface PoolWorker {
  worker: Worker;
  /** `null` settles as "unanswered" — the caller re-verifies inline. */
  pending: Map<number, (results: boolean[] | null) => void>;
  /** Set on `error`: a dead worker swallows messages, so never dispatch again. */
  dead: boolean;
}

/**
 * The pool, built at most once. `undefined` = not yet attempted; `null` =
 * attempted and unavailable (always inline); an array = workers, of which the
 * dead are skipped at dispatch time.
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
      const entry: PoolWorker = { worker, pending: new Map(), dead: false };
      worker.onmessage = (event: MessageEvent<VerifyResponse>) => {
        const { id, results } = event.data;
        const settle = entry.pending.get(id);
        if (settle) {
          entry.pending.delete(id);
          settle(results);
        }
      };
      // A worker that dies is retired for good — a later postMessage to it
      // would vanish silently and hang its round. Whatever it still owed is
      // settled "unanswered" so those chunks are re-verified inline, not
      // declared forged.
      worker.onerror = () => {
        entry.dead = true;
        for (const settle of entry.pending.values()) settle(null);
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

/**
 * One chunk to one worker. Resolves the worker's answer, or `null` when no
 * answer will come (the channel threw, or the worker errored mid-round) — the
 * caller then verifies the chunk inline.
 */
function dispatch(entry: PoolWorker, triples: VerifyTriple[]): Promise<boolean[] | null> {
  const id = nextRoundId++;
  const request: VerifyRequest = { id, triples };
  return new Promise<boolean[] | null>((resolve) => {
    entry.pending.set(id, resolve);
    try {
      entry.worker.postMessage(request);
    } catch {
      entry.pending.delete(id);
      entry.dead = true;
      resolve(null);
    }
  });
}

/**
 * The {@link EcVerifyBatch} the app hands `verifyEventsOnce`: split the residue
 * across the live workers, one contiguous chunk each, and stitch the per-worker
 * answers back into one array in the caller's order.
 *
 * A chunk with no usable answer — its worker died, threw, or replied with the
 * wrong shape — is verified inline instead, so a worker failure only ever moves
 * the work back to this thread, never converts valid signatures into "forged".
 */
export const ecVerifyBatch: EcVerifyBatch = async (triples: VerifyTriple[]): Promise<boolean[]> => {
  if (triples.length === 0) return [];

  const workers = ensurePool()?.filter((entry) => !entry.dead);
  if (!workers || workers.length === 0 || triples.length < INLINE_THRESHOLD) {
    return verifyInline(triples);
  }

  // Contiguous chunks, one per live worker; the last takes the remainder.
  const chunkSize = Math.ceil(triples.length / workers.length);
  const chunks: VerifyTriple[][] = [];
  for (let i = 0; i < triples.length; i += chunkSize) {
    chunks.push(triples.slice(i, i + chunkSize));
  }

  const parts = await Promise.all(chunks.map((chunk, i) => dispatch(workers[i], chunk)));

  const out: boolean[] = [];
  for (let c = 0; c < chunks.length; c++) {
    let answered = parts[c];
    if (!answered || answered.length !== chunks[c].length) {
      answered = await verifyInline(chunks[c]);
    }
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
