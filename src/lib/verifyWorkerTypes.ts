/**
 * Message contract between {@link verifyPool} and the Schnorr EC-verify worker.
 *
 * Its own module (like `video/types.ts`) so the main thread imports the shape
 * without pulling `@noble` into the main bundle through the worker file.
 */

import type { VerifyTriple } from "./verifyCache";

/** A batch to verify, tagged with a round id so replies can be matched up. */
export interface VerifyRequest {
  id: number;
  triples: VerifyTriple[];
}

/** One boolean per triple, in the request's order, tagged with its round id. */
export interface VerifyResponse {
  id: number;
  results: boolean[];
}
