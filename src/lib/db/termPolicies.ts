/**
 * The ONLY table of {@link TermPolicy}s (engines never interpret tenant ids);
 * two spellings would silently file rows under terms nothing reads. Mirrored by
 * Electron main (`electronMain.ts`), Android `TermPolicy.kt` and iOS
 * `TermPolicy.swift`. Keep dependency-light: bundled into `electron/db.cjs`.
 */

import { DM17_TENANT_PREFIX, dmTermPolicy } from "@/lib/nip17/conversation";

import type { TenantOpts, TermPolicy } from "./types";

/** Tenant id prefix → the policy for every tenant under it. */
const POLICIES: ReadonlyArray<readonly [prefix: string, policy: TermPolicy]> = [
  // A NIP-17 conversation is a participant SET (see `nip17/conversation.ts`).
  [DM17_TENANT_PREFIX, dmTermPolicy],
];

/**
 * BUMP THIS whenever any policy changes what it derives; otherwise on-disk rows
 * silently keep old terms. A mismatch drops and re-derives the tenant's terms.
 * Must equal `TermPolicies.GENERATION` (Kotlin) and `.generation` (Swift) — they
 * share one file, or every open rebuilds forever.
 *
 *   1  `conv:<peers>`.
 *   2  adds `convmsg:<peers>` and `convmine:<peers>` (conversation list as a collapse).
 *   3  only 64-char lowercase-hex `p` values name participants.
 */
export const TERM_GENERATION = 3;

/** The policy for `tenantId`, or `undefined` (term reads then match nothing). */
export function termPolicyFor(tenantId: string): TermPolicy | undefined {
  return POLICIES.find(([prefix]) => tenantId.startsWith(prefix))?.[1];
}

/** {@link termPolicyFor} as `tenant()` options, including the generation. */
export function tenantOptsFor(tenantId: string): TenantOpts {
  const terms = termPolicyFor(tenantId);
  return terms ? { terms, termsGeneration: TERM_GENERATION } : {};
}
