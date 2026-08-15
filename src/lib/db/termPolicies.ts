/**
 * The one table of {@link TermPolicy}s: which tenants derive index terms, and
 * what they derive.
 *
 * The engines never interpret a tenant id or a term — that is the contract in
 * `types.ts`, and it is why nothing NIP-17-shaped is inside any of them. This
 * file is where the knowledge lives instead, and it is deliberately the ONLY
 * place, because a policy that two callers spell differently files rows under a
 * term nothing looks up: a silent read of nothing, repairable only by dropping
 * the index and walking the tenant again.
 *
 * Every process that opens a store consults it, including the two that are not
 * the app: the Electron main process, which rebuilds tenants from a string it
 * receives over IPC (`electronMain.ts`), and — in their own languages, against
 * the same tenant ids — Android's `TermPolicy.kt` and iOS's `TermPolicy.swift`,
 * whose conformance suites pin them to the vectors this side produces.
 *
 * Keep it dependency-light. It is bundled into `electron/db.cjs`, a process
 * with no reason to link the client's crypto.
 */

import { DM17_TENANT_PREFIX, dmTermPolicy } from "@/lib/nip17/conversation";

import type { TermPolicy } from "./types";

/** Tenant id prefix → the policy for every tenant under it. */
const POLICIES: ReadonlyArray<readonly [prefix: string, policy: TermPolicy]> = [
  // A NIP-17 conversation is a participant SET, which a NIP-01 filter can only
  // over-select. See `nip17/conversation.ts`.
  [DM17_TENANT_PREFIX, dmTermPolicy],
];

/**
 * The policy governing `tenantId`, or `undefined` when it derives no terms —
 * which is most tenants, and means a term read against one matches nothing.
 */
export function termPolicyFor(tenantId: string): TermPolicy | undefined {
  return POLICIES.find(([prefix]) => tenantId.startsWith(prefix))?.[1];
}

/**
 * {@link termPolicyFor} as the options a `tenant()` call takes, so acquiring a
 * store is one expression and no caller has to remember the shape.
 */
export function tenantOptsFor(tenantId: string): { terms?: TermPolicy } {
  const terms = termPolicyFor(tenantId);
  return terms ? { terms } : {};
}
