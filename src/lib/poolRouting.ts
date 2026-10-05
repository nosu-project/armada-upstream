/**
 * Where a pool-wide REQ goes. Generic filters target only the GENERAL relays
 * (app + platform + NIP-65); fanning to every joined server would deliver each
 * event once per relay. The full pool is used when the general set is empty
 * (air-gapped), a filter has no `kinds` (ids/tag lookups may live anywhere),
 * or it asks for {@link FULL_POOL_KINDS} (kind 10009 may only be on a server).
 * Publishing is untouched.
 */
import type { NostrFilter } from "@nostrify/nostrify";

/** Kinds whose pool-wide reads keep the full fan-out (see module doc). */
export const FULL_POOL_KINDS: ReadonlySet<number> = new Set([10009]);

/** Relays a pool-wide REQ should target (see module doc). */
export function poolReqTargets(
  filters: NostrFilter[],
  generalRelays: string[],
  allRelays: string[],
): string[] {
  if (generalRelays.length === 0) return allRelays;
  const needsFullPool = filters.some(
    (filter) => filter.kinds?.some((kind) => FULL_POOL_KINDS.has(kind)) ?? true,
  );
  return needsFullPool ? allRelays : generalRelays;
}
