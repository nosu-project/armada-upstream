/**
 * Message contract between {@link verifyPool} and the EC worker; separate
 * module so the main thread doesn't bundle `@noble` via the worker. `sign`
 * jobs are pre-hashed NIP-42 stream-key AUTHs (`streamAuth.ts`).
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

/** One hex signature per job; `null` = malformed key (no AUTH, never retried). */
export interface SignResponse {
  id: number;
  results: (string | null)[];
}

export type WorkerResponse = VerifyResponse | SignResponse;
