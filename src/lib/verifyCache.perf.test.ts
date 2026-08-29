/**
 * Measurement harness for the "move Schnorr verify off the main thread"
 * question (NOT a correctness gate — see the loose assertions).
 *
 * The live profile put first-time signature verification at ~28% of GeckoMain
 * inclusive CPU during sync, on the main thread. The memo in `verifyCache.ts`
 * already makes verification O(unique events) rather than O(copies received),
 * so what remains is genuinely necessary work whose only escape is parallelism.
 * Before committing to the architectural change that would allow it (an async
 * verifier through `NRelay1` + auditing every direct pool consumer), this puts
 * an ABSOLUTE number on two things the profile could only show as a percentage:
 *
 *   1. What one boot's worth of unique verifies actually costs on this machine
 *      (and a rough phone projection), through the real `verifyEventOnce` path.
 *   2. The parallel speedup CEILING — the same batch split across a small
 *      `worker_threads` pool, INCLUDING the structured-clone cost of shipping
 *      the (sig, id, pubkey) triples both ways, which is the overhead a real
 *      crypto worker would pay and the thing that decides the break-even.
 *
 * `worker_threads` stands in for the browser `Worker`: same @noble code, same
 * postMessage/structured-clone cost model. The parallel leg is best-effort — if
 * a worker can't spawn in this environment it is skipped and the baseline still
 * reports.
 */
import { schnorr } from "@noble/curves/secp256k1.js";
import { hexToBytes } from "@noble/hashes/utils.js";
import { createRequire } from "node:module";
import { cpus } from "node:os";
import { pathToFileURL } from "node:url";
import { Worker } from "node:worker_threads";
import { finalizeEvent, generateSecretKey, getPublicKey } from "nostr-tools/pure";
import { beforeAll, describe, expect, it } from "vitest";

import { _resetVerifyCacheForTests, verifyEventOnce } from "./verifyCache";

import type { NostrEvent } from "@nostrify/nostrify";

/** Boot corpus size — the comments cite "~2k unique events" stored on one boot. */
const N = Number(process.env.ARMADA_PERF_N ?? 2000);
/** A realistic small pool: cores minus a couple, capped, at least one. */
const POOL = Math.max(1, Math.min(4, cpus().length - 2));
/** Rough desktop→phone slowdown for EC point math, for the projection only. */
const PHONE_FACTOR = 7;

/** The only three fields the worker (or a raw verify) needs. */
interface Triple {
  sig: string;
  id: string;
  pubkey: string;
}

/** A tiny deterministic RNG so the corpus is the same run to run. */
function lcg(seed: number): () => number {
  let s = seed >>> 0;
  return () => {
    s = (s * 1664525 + 1013904223) >>> 0;
    return s / 0x100000000;
  };
}

function ms(fn: () => void): number {
  const t = performance.now();
  fn();
  return performance.now() - t;
}

/** A signed corpus that looks like chat traffic: a handful of authors, varied
 *  content length, a few tags. Signing dominates setup, so N is bounded. */
function buildCorpus(n: number): NostrEvent[] {
  const rng = lcg(0xc0ffee);
  const authors = Array.from({ length: 40 }, () => {
    const sk = generateSecretKey();
    return { sk, pk: getPublicKey(sk) };
  });
  const events: NostrEvent[] = [];
  for (let i = 0; i < n; i++) {
    const author = authors[Math.floor(rng() * authors.length)];
    const len = 10 + Math.floor(rng() * 390);
    const content = "x".repeat(len);
    const tags: string[][] = [["h", "room"], ["p", authors[Math.floor(rng() * authors.length)].pk]];
    if (rng() < 0.3) tags.push(["e", "0".repeat(64)]);
    events.push(
      finalizeEvent(
        { kind: 9, content, tags, created_at: 1_700_000_000 + i },
        author.sk,
      ),
    );
  }
  return events;
}

const WORKER_CODE = `
const { parentPort, workerData } = require("node:worker_threads");
(async () => {
  const { schnorr } = await import(workerData.nobleUrl);
  const { hexToBytes } = await import(workerData.utilsUrl);
  parentPort.on("message", (batch) => {
    const out = new Array(batch.length);
    for (let i = 0; i < batch.length; i++) {
      const t = batch[i];
      try { out[i] = schnorr.verify(hexToBytes(t.sig), hexToBytes(t.id), hexToBytes(t.pubkey)); }
      catch { out[i] = false; }
    }
    parentPort.postMessage(out);
  });
  parentPort.postMessage("ready");
})();
`;

function verifyRound(worker: Worker, batch: Triple[]): Promise<boolean[]> {
  return new Promise((resolve, reject) => {
    worker.once("message", (msg: unknown) => resolve(msg as boolean[]));
    worker.once("error", reject);
    worker.postMessage(batch);
  });
}

describe("verify throughput: main thread vs. worker pool", () => {
  let events: NostrEvent[];
  let triples: Triple[];

  beforeAll(() => {
    events = buildCorpus(N);
    triples = events.map((e) => ({ sig: e.sig, id: e.id, pubkey: e.pubkey }));
  });

  it(`quantifies one boot's unique verifies (N=${N}) and the parallel ceiling`, async () => {
    // ── 1. The real path, cold: hash recompute + memo miss + EC verify. ──
    _resetVerifyCacheForTests();
    let coldOk = 0;
    const coldMs = ms(() => {
      for (const e of events) if (verifyEventOnce(e)) coldOk++;
    });

    // ── 2. The real path, warm: every id is now a memo hit. ──
    let warmOk = 0;
    const warmMs = ms(() => {
      for (const e of events) if (verifyEventOnce(e)) warmOk++;
    });

    // ── 3. Raw EC verify only (no hash, no memo) — the worker's actual work. ──
    const bytes = triples.map((t) => ({
      sig: hexToBytes(t.sig),
      id: hexToBytes(t.id),
      pubkey: hexToBytes(t.pubkey),
    }));
    let rawOk = 0;
    const rawMs = ms(() => {
      for (const b of bytes) if (schnorr.verify(b.sig, b.id, b.pubkey)) rawOk++;
    });

    // ── 4. Correctness: a tampered sig must fail. ──
    const tampered = { ...events[0], sig: "00".repeat(64) };
    _resetVerifyCacheForTests();
    const tamperedOk = verifyEventOnce(tampered);

    expect(coldOk).toBe(N);
    expect(warmOk).toBe(N);
    expect(rawOk).toBe(N);
    expect(tamperedOk).toBe(false);
    // The memo is the whole reason cross-relay copies are free: warm must be a
    // small fraction of cold. (Stable across machines; the ms values are not.)
    expect(warmMs).toBeLessThan(coldMs / 5);

    const perColdUs = (coldMs / N) * 1000;
    const perRawUs = (rawMs / N) * 1000;

    // ── 5. Parallel ceiling (best-effort). ──
    let poolLine = "  parallel: SKIPPED (no worker in this environment)";
    let spawnMs = NaN;
    let parallelMs = NaN;
    try {
      const require_ = createRequire(import.meta.url);
      const nobleUrl = pathToFileURL(require_.resolve("@noble/curves/secp256k1.js")).href;
      const utilsUrl = pathToFileURL(require_.resolve("@noble/hashes/utils.js")).href;

      const tSpawn = performance.now();
      const workers = Array.from(
        { length: POOL },
        () => new Worker(WORKER_CODE, { eval: true, workerData: { nobleUrl, utilsUrl } }),
      );
      // First message from each worker is its "ready" handshake.
      await Promise.all(
        workers.map((w) => new Promise<void>((res) => w.once("message", () => res()))),
      );
      spawnMs = performance.now() - tSpawn;

      // Split the corpus into POOL contiguous chunks, one per worker.
      const chunkSize = Math.ceil(N / POOL);
      const chunks: Triple[][] = [];
      for (let i = 0; i < N; i += chunkSize) chunks.push(triples.slice(i, i + chunkSize));

      // Warm the workers once (JIT + first import), then time a steady round.
      await Promise.all(chunks.map((c, i) => verifyRound(workers[i % POOL], c)));

      const tPar = performance.now();
      const parts = await Promise.all(chunks.map((c, i) => verifyRound(workers[i % POOL], c)));
      parallelMs = performance.now() - tPar;

      const parOk = parts.reduce((sum, p) => sum + p.filter(Boolean).length, 0);
      expect(parOk).toBe(N);

      await Promise.all(workers.map((w) => w.terminate()));

      const speedupVsCold = coldMs / parallelMs;
      const speedupVsRaw = rawMs / parallelMs;
      poolLine =
        `  parallel: ${POOL} workers, spawn ${spawnMs.toFixed(0)}ms (once), ` +
        `round ${parallelMs.toFixed(1)}ms  →  ${speedupVsCold.toFixed(1)}x vs cold main-thread, ` +
        `${speedupVsRaw.toFixed(1)}x vs raw`;
    } catch (err) {
      poolLine = `  parallel: SKIPPED (${err instanceof Error ? err.message : String(err)})`;
    }

    console.log(
      [
        ``,
        `=== Schnorr verify throughput (N=${N} unique events, ${POOL}-worker pool) ===`,
        `  cold verifyEventOnce : ${coldMs.toFixed(0)}ms total, ${perColdUs.toFixed(1)}µs/event` +
          `  (~${((coldMs * PHONE_FACTOR) / 1000).toFixed(1)}s projected on a phone ×${PHONE_FACTOR})`,
        `  warm (all memo hits) : ${warmMs.toFixed(0)}ms total  (the memo already erases cross-relay copies)`,
        `  raw schnorr.verify   : ${rawMs.toFixed(0)}ms total, ${perRawUs.toFixed(1)}µs/event  (EC only, no hash/memo)`,
        poolLine,
        ``,
      ].join("\n"),
    );
  }, 120_000);
});
