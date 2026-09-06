/**
 * The pool's failure contract, pinned:
 *
 *  1. a worker that has ERRORED is never dispatched to again — otherwise it
 *     stays in the pool and a later batch awaits a reply that can never come,
 *     hanging the decode (and `openChatBatch` above it) forever;
 *  2. a worker failure reads as "verify this chunk on this thread", never as
 *     "every signature in the chunk is forged" — `openChatBatch` memoizes a
 *     false verdict per wrap, so a transient worker death would otherwise
 *     poison the decode memo for perfectly good messages for the session;
 *  3. the inline path yields — it runs on the main thread precisely when the
 *     pool can't, and an unsliced loop over a batch of ~ms-each EC verifies is
 *     the jank the pool exists to remove;
 *  4. a worker that never replies AND never errors (a module fetch that
 *     stalls) cannot hang a batch: the round's deadline hands the chunk back
 *     to this thread and retires the worker.
 *
 * `Worker` doesn't exist in the node test environment, which is what makes the
 * pool testable: a stubbed global stands in, and the tests drive its failures
 * deterministically. The real signatures are still really verified — the
 * stub's "reply" behavior and the inline fallback both run @noble.
 */
import { schnorr } from "@noble/curves/secp256k1.js";
import { hexToBytes } from "@noble/hashes/utils.js";
import { finalizeEvent, generateSecretKey } from "nostr-tools/pure";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { _resetVerifyPoolForTests, ecVerifyBatch } from "./verifyPool";

import type { VerifyTriple } from "./verifyCache";
import type { VerifyRequest, VerifyResponse } from "./verifyWorkerTypes";

function realVerify(t: VerifyTriple): boolean {
  try {
    return schnorr.verify(hexToBytes(t.sig), hexToBytes(t.id), hexToBytes(t.pubkey));
  } catch {
    return false;
  }
}

/**
 * Stands in for the browser `Worker` the pool builds. Default behavior is the
 * real worker's: verify the triples and reply asynchronously. Tests flip a
 * per-instance behavior to model the failure modes — a worker that dies on
 * receipt (fires `error`, never replies), one whose channel throws, and one
 * already broken (a message to it simply vanishes, which is what dispatching
 * to a dead browser worker does).
 */
class FakeWorker {
  static instances: FakeWorker[] = [];
  static messages = 0;
  behavior: "reply" | "die-on-message" | "throw-on-message" | "silent" = "reply";
  broken = false;
  terminated = false;
  /** Requests a "silent" worker swallowed, so a test can answer them late. */
  swallowed: VerifyRequest[] = [];
  onmessage: ((event: { data: VerifyResponse }) => void) | null = null;
  onerror: ((event: unknown) => void) | null = null;

  constructor() {
    FakeWorker.instances.push(this);
  }

  postMessage(request: VerifyRequest): void {
    FakeWorker.messages++;
    if (this.behavior === "throw-on-message") throw new Error("dead channel");
    if (this.broken) return;
    if (this.behavior === "die-on-message") {
      this.die();
      return;
    }
    if (this.behavior === "silent") {
      this.swallowed.push(request);
      return;
    }
    const results = request.triples.map(realVerify);
    queueMicrotask(() => this.onmessage?.({ data: { id: request.id, results } }));
  }

  terminate(): void {
    this.terminated = true;
  }

  die(): void {
    this.broken = true;
    queueMicrotask(() => this.onerror?.(new Event("error")));
  }
}

/** A validly signed corpus, as (sig, id, pubkey) triples. */
function triples(n: number): VerifyTriple[] {
  const out: VerifyTriple[] = [];
  for (let i = 0; i < n; i++) {
    const ev = finalizeEvent(
      { kind: 1, content: `msg ${i}`, tags: [], created_at: 1000 + i },
      generateSecretKey(),
    );
    out.push({ sig: ev.sig, id: ev.id, pubkey: ev.pubkey });
  }
  return out;
}

beforeEach(() => {
  _resetVerifyPoolForTests();
  FakeWorker.instances = [];
  FakeWorker.messages = 0;
  vi.stubGlobal("Worker", FakeWorker);
});

afterEach(() => {
  _resetVerifyPoolForTests();
  vi.unstubAllGlobals();
});

describe("ecVerifyBatch", () => {
  // 30 is comfortably past the pool's inline threshold (24), so these batches
  // actually exercise the workers.
  it("splits a large batch across workers and stitches results in input order", async () => {
    const batch = triples(30);
    batch[3] = { ...batch[3], sig: "00".repeat(64) };
    batch[17] = { ...batch[17], sig: "00".repeat(64) };

    const results = await ecVerifyBatch(batch);

    expect(results).toHaveLength(30);
    expect(FakeWorker.messages).toBeGreaterThan(0);
    for (let i = 0; i < 30; i++) {
      expect(results[i]).toBe(i !== 3 && i !== 17);
    }
  });

  it("runs a small batch inline without a worker round trip", async () => {
    const batch = triples(3);
    const results = await ecVerifyBatch(batch);
    expect(results).toEqual([true, true, true]);
    expect(FakeWorker.messages).toBe(0);
  });

  it("completes a batch after a worker has died, instead of hanging on it", async () => {
    // Round 1 builds the pool and succeeds.
    const first = await ecVerifyBatch(triples(30));
    expect(first.every(Boolean)).toBe(true);

    // A worker dies between rounds (module fetch failure, OOM kill): its
    // `error` event fires with nothing in flight, and any message sent to it
    // afterwards simply vanishes.
    FakeWorker.instances[0].die();
    await new Promise((resolve) => setTimeout(resolve, 0));

    const batch = triples(30);
    const outcome = await Promise.race([
      ecVerifyBatch(batch).then((results) => ({ results })),
      new Promise<"hang">((resolve) => setTimeout(() => resolve("hang"), 500)),
    ]);

    expect(outcome).not.toBe("hang");
    if (outcome !== "hang") {
      expect(outcome.results).toHaveLength(30);
      expect(outcome.results.every(Boolean)).toBe(true);
    }
  });

  it("does not read valid signatures as forged when a worker errors mid-round", async () => {
    // Build the pool with a quick round, then make one worker die on receipt.
    await ecVerifyBatch(triples(30));
    FakeWorker.instances[0].behavior = "die-on-message";

    const results = await ecVerifyBatch(triples(30));

    // Every signature is genuinely valid; the dead worker's chunk must be
    // verified here rather than declared forged (openChatBatch memoizes a
    // false verdict, so "forged" would stick for the session).
    expect(results).toHaveLength(30);
    expect(results.every(Boolean)).toBe(true);
  });

  it("does not read valid signatures as forged when postMessage throws", async () => {
    await ecVerifyBatch(triples(30));
    FakeWorker.instances[0].behavior = "throw-on-message";

    const results = await ecVerifyBatch(triples(30));

    expect(results).toHaveLength(30);
    expect(results.every(Boolean)).toBe(true);
  });

  it("completes a batch when a worker never replies, and retires it", async () => {
    // A stalled worker fires no event at all — nothing but a deadline can
    // notice it. Pin the deadline short so the test needn't wait out the
    // production budget.
    _resetVerifyPoolForTests({ roundDeadlineMs: 20 });
    await ecVerifyBatch(triples(30));
    const stalled = FakeWorker.instances[0];
    stalled.behavior = "silent";

    const batch = triples(30);
    const outcome = await Promise.race([
      ecVerifyBatch(batch).then((results) => ({ results })),
      new Promise<"hang">((resolve) => setTimeout(() => resolve("hang"), 500)),
    ]);

    expect(outcome).not.toBe("hang");
    if (outcome !== "hang") {
      expect(outcome.results).toHaveLength(30);
      // Every signature is valid: the stalled chunk was re-verified here.
      expect(outcome.results.every(Boolean)).toBe(true);
    }
    expect(stalled.swallowed).toHaveLength(1);
    expect(stalled.terminated).toBe(true);

    // Retired: the next round goes nowhere near it.
    const before = stalled.swallowed.length;
    expect((await ecVerifyBatch(triples(30))).every(Boolean)).toBe(true);
    expect(stalled.swallowed).toHaveLength(before);

    // A reply that turns up after the deadline lands nowhere — no throw, and
    // no second settle of an already-settled round.
    const late = stalled.swallowed[0];
    expect(() =>
      stalled.onmessage?.({ data: { id: late.id, results: late.triples.map(() => false) } }),
    ).not.toThrow();
  });

  it("yields to the event loop while verifying inline", async () => {
    // No Worker at all: the whole batch runs on this thread — which is exactly
    // when blocking matters. A macrotask queued before the call must get to
    // run before the batch resolves; an unsliced loop would starve it.
    _resetVerifyPoolForTests();
    vi.stubGlobal("Worker", undefined);

    const base = triples(30);
    const batch: VerifyTriple[] = [];
    while (batch.length < 300) batch.push(...base);

    let interleaved = false;
    setTimeout(() => {
      interleaved = true;
    }, 0);

    const results = await ecVerifyBatch(batch);

    expect(results).toHaveLength(batch.length);
    expect(results.every(Boolean)).toBe(true);
    expect(interleaved).toBe(true);
  });
});
