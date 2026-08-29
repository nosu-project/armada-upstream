/// <reference lib="webworker" />

/**
 * Schnorr EC-verify worker.
 *
 * Does ONE thing: given a batch of `(sig, id, pubkey)` triples, return one
 * boolean per triple in order. No hashing, no memo, no event shape — the memo
 * and the id-is-the-hash security argument stay on the main thread in
 * `verifyCache.ts` (`hashGate`), which is why this worker is handed pre-hashed
 * ids it never recomputes and could never be tricked by: a triple whose `id`
 * doesn't match its content was already dropped before it got here.
 *
 * Imports `@noble` ONLY, so it stays a tiny module worker that never pulls the
 * app (or the store, or nostr-tools) into a second bundle. See `verifyPool.ts`
 * for the pool that drives it and the inline fallback when a `Worker` can't be
 * constructed.
 */

import { schnorr } from "@noble/curves/secp256k1.js";
import { hexToBytes } from "@noble/hashes/utils.js";

import type { VerifyRequest, VerifyResponse } from "./verifyWorkerTypes";

/** Verify one triple. Any malformed hex reads as invalid, never as a throw. */
function verifyOne(sig: string, id: string, pubkey: string): boolean {
  try {
    return schnorr.verify(hexToBytes(sig), hexToBytes(id), hexToBytes(pubkey));
  } catch {
    return false;
  }
}

self.onmessage = (event: MessageEvent<VerifyRequest>) => {
  const { id, triples } = event.data;
  const results = new Array<boolean>(triples.length);
  for (let i = 0; i < triples.length; i++) {
    const t = triples[i];
    results[i] = verifyOne(t.sig, t.id, t.pubkey);
  }
  post({ id, results });
};

function post(response: VerifyResponse): void {
  (self as unknown as DedicatedWorkerGlobalScope).postMessage(response);
}
