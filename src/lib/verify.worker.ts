/// <reference lib="webworker" />

/**
 * Schnorr EC worker: verify or sign.
 *
 * Does the curve arithmetic ONLY. For a verify batch, given `(sig, id,
 * pubkey)` triples, return one boolean per triple in order. No hashing, no
 * memo, no event shape — the memo and the id-is-the-hash security argument
 * stay on the main thread in `verifyCache.ts` (`hashGate`), which is why this
 * worker is handed pre-hashed ids it never recomputes and could never be
 * tricked by: a triple whose `id` doesn't match its content was already
 * dropped before it got here.
 *
 * For a sign batch, given `(hash, secret key)` jobs, return one hex signature
 * per job (or `null` where the key is unusable). The hash is likewise computed
 * by the caller (`streamAuth.ts`), so signing here is the bare BIP-340
 * operation nostr-tools' `finalizeEvent` would run — including @noble's
 * self-verify of the fresh signature, which is most of a sign's cost and the
 * reason it belongs off the main thread.
 *
 * Imports `@noble` ONLY, so it stays a tiny module worker that never pulls the
 * app (or the store, or nostr-tools) into a second bundle. See `verifyPool.ts`
 * for the pool that drives it and the inline fallback when a `Worker` can't be
 * constructed.
 */

import { schnorr } from "@noble/curves/secp256k1.js";
import { bytesToHex, hexToBytes } from "@noble/hashes/utils.js";

import type { WorkerRequest, WorkerResponse } from "./verifyWorkerTypes";

/** Verify one triple. Any malformed hex reads as invalid, never as a throw. */
function verifyOne(sig: string, id: string, pubkey: string): boolean {
  try {
    return schnorr.verify(hexToBytes(sig), hexToBytes(id), hexToBytes(pubkey));
  } catch {
    return false;
  }
}

/** Sign one hash. A malformed key reads as `null`, never as a throw. */
function signOne(hash: string, sk: Uint8Array): string | null {
  try {
    return bytesToHex(schnorr.sign(hexToBytes(hash), sk));
  } catch {
    return null;
  }
}

self.onmessage = (event: MessageEvent<WorkerRequest>) => {
  const request = event.data;
  if (request.op === "sign") {
    post({ id: request.id, results: request.jobs.map((job) => signOne(job.hash, job.sk)) });
    return;
  }
  post({ id: request.id, results: request.triples.map((t) => verifyOne(t.sig, t.id, t.pubkey)) });
};

function post(response: WorkerResponse): void {
  (self as unknown as DedicatedWorkerGlobalScope).postMessage(response);
}
