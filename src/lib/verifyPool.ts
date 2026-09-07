/**
 * The worker pool behind {@link verifyCache}'s {@link EcVerifyBatch} seam —
 * and, through {@link ecSignBatch}, behind the NIP-42 stream-key signing in
 * `streamAuth.ts`.
 *
 * Schnorr verify was ~28% of GeckoMain's inclusive CPU during sync (profiled),
 * all on the main thread, and it is first-time-necessary work the memo can't
 * erase — only parallelism can. This spreads the EC verify of a decode batch
 * across a small pool of `verify.worker.ts` module workers, keeping the main
 * thread free to paint while a cold backfill's signatures are checked off it.
 * A later profile of a community switch found the same shape in SIGNING: a
 * relay challenge signs a kind-22242 per stream key the relay hosts, and
 * @noble's `sign` verifies its own output, so each was ~4ms on the main thread
 * and a switch burned ~1.6s of them. The same workers now take those too.
 *
 * The pool does the EC ONLY: `verifyCache.ts`'s `hashGate` has already bound
 * every id to the copy in hand and consulted the memo on the MAIN thread, so
 * what reaches a worker is a pre-hashed `(sig, id, pubkey)` triple it cannot be
 * tricked by; a sign job is likewise a pre-hashed id plus its key. See
 * `verify.worker.ts`.
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
 * chunk is computed inline and the worker retired. Two more paths keep the
 * pool from ever being worse than inline:
 *
 *  - **No `Worker`** (SSR, a locked-down runtime, a CSP that forbids the
 *    blob/module worker): construction is attempted ONCE, and any failure pins
 *    the pool "unavailable" so every batch runs inline forever after.
 *  - **A small batch** isn't worth a round trip: below the operation's inline
 *    threshold, the fixed postMessage + structured-clone cost dominates the
 *    handful of operations it would parallelize, so those run inline too. This
 *    is the common live-delivery case (a message or two at a time); the pool
 *    is for the backfill and the challenge.
 *
 * The inline path itself is time-sliced ({@link INLINE_SLICE_MS}): it runs on
 * the main thread precisely when the pool can't, and an unsliced loop over a
 * batch of ~ms-each EC operations is the jank the pool exists to remove.
 */

import { schnorr } from "@noble/curves/secp256k1.js";
import { bytesToHex, hexToBytes } from "@noble/hashes/utils.js";

import type { EcVerifyBatch, VerifyTriple } from "./verifyCache";
import type { SignJob, WorkerRequest, WorkerResponse } from "./verifyWorkerTypes";

/**
 * How many triples a verify batch must have before the pool is worth using.
 * Below it, the round trip costs more than the verifies it parallelizes
 * (measured: a warm round is ~1ms of fixed overhead against ~1.8ms/verify on
 * desktop, more on a phone), so a small live delivery stays inline.
 */
const VERIFY_INLINE_THRESHOLD = 24;

/**
 * The same for signing, where each operation is a sign PLUS @noble's
 * self-verify (~4ms on desktop): two already outweigh the round trip, and a
 * lone AUTH — the single stream key NostrProvider answers a slow bunker with —
 * stays inline where its latency is lowest.
 */
const SIGN_INLINE_THRESHOLD = 2;

/**
 * How long an inline slice may run before yielding — matches `openChatBatch`'s
 * decode slice, since the inline verify runs interleaved with that loop's
 * budget on the same thread.
 */
const INLINE_SLICE_MS = 5;

/**
 * How long a round may go unanswered before its chunk is computed inline and
 * the worker retired: a fixed allowance for the worker's first module load,
 * plus a per-item budget generous enough that a slow phone under load (tens
 * of ms per verify, twice that per sign) still finishes with room to spare. A
 * deadline that fires early costs nothing but the duplicated work — the inline
 * answer is the same answer — but it also retires the worker for the session,
 * which is why the budget errs long.
 */
const ROUND_DEADLINE_BASE_MS = 2_000;
const ROUND_DEADLINE_PER_VERIFY_MS = 50;
const ROUND_DEADLINE_PER_SIGN_MS = 100;

let roundDeadlineOverride: number | undefined;

function roundDeadlineMs(request: WorkerRequest): number {
  if (roundDeadlineOverride !== undefined) return roundDeadlineOverride;
  return request.op === "sign"
    ? ROUND_DEADLINE_BASE_MS + ROUND_DEADLINE_PER_SIGN_MS * request.jobs.length
    : ROUND_DEADLINE_BASE_MS + ROUND_DEADLINE_PER_VERIFY_MS * request.triples.length;
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

/** One sign job, inline. A malformed key reads as `null`, never as a throw. */
function signOneInline(job: SignJob): string | null {
  try {
    return bytesToHex(schnorr.sign(hexToBytes(job.hash), job.sk));
  } catch {
    return null;
  }
}

/**
 * A batch on this thread — the fallback and the small-batch path — sliced so
 * the main thread keeps painting while it runs. Each operation is
 * milliseconds, so the yield check runs per item rather than per group.
 */
async function runInline<J, R>(items: J[], one: (item: J) => R): Promise<R[]> {
  const out = new Array<R>(items.length);
  let sliceStart = performance.now();
  for (let i = 0; i < items.length; i++) {
    out[i] = one(items[i]);
    if (i + 1 < items.length && performance.now() - sliceStart >= INLINE_SLICE_MS) {
      await new Promise((resolve) => setTimeout(resolve, 0));
      sliceStart = performance.now();
    }
  }
  return out;
}

/** One round in flight: how to settle it, and the deadline that settles it "unanswered". */
interface PendingRound {
  /** `null` settles as "unanswered" — the caller recomputes inline. */
  settle: (results: unknown[] | null) => void;
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
 * "unanswered" (so those chunks are recomputed inline, not declared forged or
 * unsigned), and the worker itself is terminated so a stalled one holds no
 * resources and a late reply lands nowhere.
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
      worker.onmessage = (event: MessageEvent<WorkerResponse>) => {
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
 * round's deadline passed with no reply) — the caller then computes the chunk
 * inline. Every path that yields `null` also retires the worker.
 */
function dispatch(entry: PoolWorker, request: WorkerRequest): Promise<unknown[] | null> {
  return new Promise<unknown[] | null>((resolve) => {
    const deadline = setTimeout(() => {
      // Still owed: the worker is stalled. Retiring it settles this round
      // (and anything else it owes) as unanswered.
      if (entry.pending.has(request.id)) retire(entry);
    }, roundDeadlineMs(request));
    entry.pending.set(request.id, { settle: resolve, deadline });
    try {
      entry.worker.postMessage(request);
    } catch {
      retire(entry);
    }
  });
}

/**
 * The shared shape of both operations: split the items across the live
 * workers, one contiguous chunk each, and stitch the per-worker answers back
 * into one array in the caller's order.
 *
 * A chunk with no usable answer — its worker died, threw, or replied with the
 * wrong shape — is computed inline instead, so a worker failure only ever
 * moves the work back to this thread, never converts valid signatures into
 * "forged" (or a key into "unsigned").
 */
async function runBatch<J, R>(
  items: J[],
  inlineThreshold: number,
  request: (chunk: J[]) => WorkerRequest,
  one: (item: J) => R,
  coerce: (answer: unknown) => R,
): Promise<R[]> {
  if (items.length === 0) return [];

  const workers = ensurePool()?.filter((entry) => !entry.dead);
  if (!workers || workers.length === 0 || items.length < inlineThreshold) {
    return runInline(items, one);
  }

  // Contiguous chunks, one per live worker; the last takes the remainder.
  const chunkSize = Math.ceil(items.length / workers.length);
  const chunks: J[][] = [];
  for (let i = 0; i < items.length; i += chunkSize) {
    chunks.push(items.slice(i, i + chunkSize));
  }

  const parts = await Promise.all(chunks.map((chunk, i) => dispatch(workers[i], request(chunk))));

  const out: R[] = [];
  for (let c = 0; c < chunks.length; c++) {
    let answered: unknown[] | null = parts[c];
    if (!answered || answered.length !== chunks[c].length) {
      answered = await runInline(chunks[c], one);
    }
    for (let j = 0; j < chunks[c].length; j++) out.push(coerce(answered[j]));
  }
  return out;
}

/** The {@link EcVerifyBatch} the app hands `verifyEventsOnce`. */
export const ecVerifyBatch: EcVerifyBatch = (triples: VerifyTriple[]): Promise<boolean[]> =>
  runBatch(
    triples,
    VERIFY_INLINE_THRESHOLD,
    (chunk) => ({ id: nextRoundId++, op: "verify", triples: chunk }),
    verifyOneInline,
    (answer) => answer === true,
  );

/** A pluggable Schnorr batch signer: one hex signature (or `null`) per job, in order. */
export type EcSignBatch = (jobs: SignJob[]) => Promise<(string | null)[]>;

/**
 * Sign a batch of pre-hashed messages, in the pool when it is worth it and
 * inline (time-sliced) otherwise. Never throws; a job whose key is unusable
 * answers `null`. Same failure contract as {@link ecVerifyBatch}: a worker
 * failure moves the signing back to this thread, never loses a signature.
 */
export const ecSignBatch: EcSignBatch = (jobs: SignJob[]): Promise<(string | null)[]> =>
  runBatch(
    jobs,
    SIGN_INLINE_THRESHOLD,
    (chunk) => ({ id: nextRoundId++, op: "sign", jobs: chunk }),
    signOneInline,
    (answer) => (typeof answer === "string" ? answer : null),
  );

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
