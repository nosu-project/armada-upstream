/**
 * Worker pool behind {@link verifyCache}'s {@link EcVerifyBatch} seam and
 * {@link ecSignBatch} (NIP-42 stream-key signing in `streamAuth.ts`), moving
 * Schnorr verify/sign off the main thread. Workers only get pre-hashed inputs;
 * `hashGate` binds ids on the main thread.
 *
 * Failure never changes an ANSWER, only where it's computed: a worker that
 * errors, throws, or misses its deadline ({@link roundDeadlineMs}) is retired
 * and its chunk recomputed inline. A missing reply must not read as "forged" —
 * `openChatBatch` memoizes false verdicts for the session. No `Worker` (or
 * construction failure) pins the pool inline forever; small batches run inline
 * since the round trip dominates. Inline runs are time-sliced.
 */

import { schnorr } from "@noble/curves/secp256k1.js";
import { bytesToHex, hexToBytes } from "@noble/hashes/utils.js";

import type { EcVerifyBatch, VerifyTriple } from "./verifyCache";
import type { SignJob, WorkerRequest, WorkerResponse } from "./verifyWorkerTypes";

/** Min verify batch for the pool (~1ms fixed round cost vs ~1.8ms/verify on desktop). */
const VERIFY_INLINE_THRESHOLD = 24;

/** Signing (~4ms incl. @noble's self-verify): two already beat the round trip. */
const SIGN_INLINE_THRESHOLD = 2;

/** Inline slice before yielding; matches `openChatBatch`'s decode slice. */
const INLINE_SLICE_MS = 5;

/**
 * Unanswered-round deadline: module-load allowance plus a generous per-item
 * budget. Errs long, since firing retires the worker for the session.
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

/** Leave cores for the compositor; the pool is to free the UI thread, not saturate. */
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

/** A batch on this thread, yielding every INLINE_SLICE_MS. */
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
 * Retire a worker for good: owed rounds settle "unanswered" (recomputed
 * inline) and it's terminated so late replies land nowhere.
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
    // already gone
  }
}

/** `undefined` = not attempted; `null` = unavailable (always inline); array = workers. */
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
      // A dead worker silently swallows postMessage; retire it.
      worker.onerror = () => retire(entry);
      return entry;
    });
    return pool;
  } catch {
    pool = null;
    return null;
  }
}

/**
 * One chunk to one worker; `null` (worker retired) when no answer will come,
 * and the caller computes inline.
 */
function dispatch(entry: PoolWorker, request: WorkerRequest): Promise<unknown[] | null> {
  return new Promise<unknown[] | null>((resolve) => {
    const deadline = setTimeout(() => {
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
 * Split items into contiguous chunks across live workers and stitch answers
 * back in order. Chunks without a usable answer are computed inline.
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
 * Sign pre-hashed messages (pool or inline). Never throws; unusable keys answer
 * `null`. Worker failures fall back inline.
 */
export const ecSignBatch: EcSignBatch = (jobs: SignJob[]): Promise<(string | null)[]> =>
  runBatch(
    jobs,
    SIGN_INLINE_THRESHOLD,
    (chunk) => ({ id: nextRoundId++, op: "sign", jobs: chunk }),
    signOneInline,
    (answer) => (typeof answer === "string" ? answer : null),
  );

/** Test seam: tear down the pool; optionally pin the round deadline. */
export function _resetVerifyPoolForTests(opts?: { roundDeadlineMs?: number }): void {
  if (Array.isArray(pool)) for (const entry of pool) retire(entry);
  pool = undefined;
  nextRoundId = 0;
  roundDeadlineOverride = opts?.roundDeadlineMs;
}
