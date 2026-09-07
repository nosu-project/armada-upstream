/**
 * Message contract between {@link verifyPool} and the Schnorr EC worker.
 *
 * Its own module (like `video/types.ts`) so the main thread imports the shape
 * without pulling `@noble` into the main bundle through the worker file.
 *
 * Two operations share one worker, because they are the same point
 * arithmetic on the same curve and the pool's failure contract (retire a dead
 * worker, fall back inline, never answer wrong) is written once:
 *
 *  - `verify`: one boolean per `(sig, id, pubkey)` triple;
 *  - `sign`: one Schnorr signature per `(hash, secret key)` job, for the
 *    NIP-42 stream-key AUTHs (`streamAuth.ts`). The event id is hashed on the
 *    main thread — cheap — and the worker signs exactly the 32 bytes it is
 *    given, so what crosses the boundary is a hash and a key, never an event
 *    shape the worker would have to serialize.
 */

import type { VerifyTriple } from "./verifyCache";

/** A verify batch, tagged with a round id so replies can be matched up. */
export interface VerifyRequest {
  id: number;
  op: "verify";
  triples: VerifyTriple[];
}

/** One signature to produce: the 32-byte message (hex) and the secret key. */
export interface SignJob {
  hash: string;
  sk: Uint8Array;
}

/** A sign batch, tagged like a verify round. */
export interface SignRequest {
  id: number;
  op: "sign";
  jobs: SignJob[];
}

export type WorkerRequest = VerifyRequest | SignRequest;

/** One boolean per triple, in the request's order, tagged with its round id. */
export interface VerifyResponse {
  id: number;
  results: boolean[];
}

/**
 * One hex signature per job, in order; `null` where signing failed (a
 * malformed key) — which the caller treats as "no AUTH for that key", never
 * as a reason to retry.
 */
export interface SignResponse {
  id: number;
  results: (string | null)[];
}

export type WorkerResponse = VerifyResponse | SignResponse;
