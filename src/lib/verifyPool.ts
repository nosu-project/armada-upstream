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
 * errors, whose channel throws, or that simply never replies hands its chunk
 * back to this thread — a missing reply must not read as "forged", because
 * callers (`openChatBatch`) memoize a false verdict per wrap and a transient
 * worker death would poison good messages for the session. This is the
 * contract `verifyEventsOnce`'s callers lean on: {@link ecVerifyBatch} never
 * throws and never answers "unverified" for a reason other than the signature.
 * A worker that has failed in any of those ways is retired and never
 * dispatched to again: a message posted to a dead worker vanishes without an
 * error, so re-using it would leave a batch awaiting a reply that can never
 * come. The "never replies" case is the one no event announces — a module
 * fetch that stalls rather than fails fires neither `message` nor `error` —
 * so every round carries a deadline ({@link roundDeadlineMs}) after which the
 * chunk is verified inline and the worker retired. Two more paths keep the
 * pool from ever being worse than inline:
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
 * How long a round may go unanswered before its chunk is verified inline and
 * the worker retired: a fixed allowance for the worker's first module load,
 * plus a per-triple budget generous enough that a slow phone under load (tens
 * of ms per verify) still finishes with room to spare. A deadline that fires
 * early costs nothing but the duplicated work — the inline answer is the same
 * answer — but it also retires the worker for the session, which is why the
 * budget errs long.
 */
const ROUND_DEADLINE_BASE_MS = 2_000;
const ROUND_DEADLINE_PER_TRIPLE_MS = 50;

let roundDeadlineOverride: number | undefined;

function roundDeadlineMs(triples: number): number {
  return roundDeadlineOverride ?? ROUND_DEADLINE_BASE_MS + ROUND_DEADLINE_PER_TRIPLE_MS * triples;
}

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

/** One round in flight: how to settle it, and the deadline that settles it "unanswered". */
interface PendingRound {
  /** `null` settles as "unanswered" — the caller re-verifies inline. */
  settle: (results: boolean[] | null) => void;
  deadline: ReturnType<typeof setTimeout>;
}

/** A worker plus the replies it still owes, keyed by round id. */
interface PoolWorker {
  worker: Worker;
  pending: Map<number, PendingRound>;
  /** Set on any failure: a dead worker swallows messages, so never dispatch again. */
  dead: boolean;
}

/**
 * Take a worker out of service for good: every round it still owes settles
 * "unanswered" (so those chunks are re-verified inline, not declared forged),
 * and the worker itself is terminated so a stalled one holds no resources and
 * a late reply lands nowhere.
 */
function retire(entry: PoolWorker): void {
  entry.dead = true;
  for (const round of entry.pending.values()) {
    clearTimeout(round.deadline);
    round.settle(null);
  }
  entry.pending.clear();
  try {
    entry.worker.terminate();
  } catch {
    // Already gone; nothing to release.
  }
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
        const round = entry.pending.get(id);
        if (round) {
          clearTimeout(round.deadline);
          entry.pending.delete(id);
          round.settle(results);
        }
      };
      // A worker that dies is retired for good — a later postMessage to it
      // would vanish silently and hang its round.
      worker.onerror = () => retire(entry);
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
 * answer will come (the channel threw, the worker errored mid-round, or the
 * round's deadline passed with no reply) — the caller then verifies the chunk
 * inline. Every path that yields `null` also retires the worker.
 */
function dispatch(entry: PoolWorker, triples: VerifyTriple[]): Promise<boolean[] | null> {
  const id = nextRoundId++;
  const request: VerifyRequest = { id, triples };
  return new Promise<boolean[] | null>((resolve) => {
    const deadline = setTimeout(() => {
      // Still owed: the worker is stalled. Retiring it settles this round
      // (and anything else it owes) as unanswered.
      if (entry.pending.has(id)) retire(entry);
    }, roundDeadlineMs(triples.length));
    entry.pending.set(id, { settle: resolve, deadline });
    try {
      entry.worker.postMessage(request);
    } catch {
      retire(entry);
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

/**
 * Test seam: tear the pool down and forget it (a fresh test rebuilds it), and
 * optionally pin the round deadline so a stalled-worker test needn't wait out
 * the production budget.
 */
export function _resetVerifyPoolForTests(opts?: { roundDeadlineMs?: number }): void {
  if (Array.isArray(pool)) for (const entry of pool) retire(entry);
  pool = undefined;
  nextRoundId = 0;
  roundDeadlineOverride = opts?.roundDeadlineMs;
}
