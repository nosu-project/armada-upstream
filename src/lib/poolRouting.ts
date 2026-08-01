/**
 * Where a pool-wide REQ actually needs to go.
 *
 * The pool's read set is app relays + platform pins + the user's NIP-65 set +
 * every joined server (NIP-29 hosts, git relays). Group-scoped traffic reaches
 * a server through a targeted `nostr.relay(url)` and never used the pool-wide
 * fan-out — but generic traffic (profiles, statuses, DM scans, follow lists)
 * was fanned to ALL of it, so every event a query touched arrived once per
 * relay: a measured boot received ~11k copies for a store that gained no rows,
 * and every copy paid wire bandwidth plus a main-thread parse.
 *
 * So: generic filters route to the GENERAL relays (app + platform + NIP-65),
 * and the full pool is used only when
 *
 *  - the general set is empty — an air-gapped deployment runs on its servers
 *    alone, and a routing optimization must never make it read nothing;
 *  - a filter has no `kinds` — an ids-only or tag-only lookup (a quoted event,
 *    a naddr) can legitimately live anywhere, including on a server;
 *  - a filter asks for a kind in {@link FULL_POOL_KINDS} — the user's kind
 *    10009 server list is the one generic read a server plausibly holds a
 *    copy of that the general relays might not (a list published by a client
 *    that writes to the user's servers), and it is load-bearing enough that
 *    narrowing its read is not worth the copies it saves.
 *
 * Publishing (`eventRouter`) is deliberately untouched: writes are rare, and
 * wide propagation of the user's replaceable lists is a feature.
 */
import type { NostrFilter } from "@nostrify/nostrify";

/** Kinds whose pool-wide reads keep the full fan-out (see module doc). */
export const FULL_POOL_KINDS: ReadonlySet<number> = new Set([10009]);

/**
 * The relay set a pool-wide REQ should target: `generalRelays` for generic
 * traffic, `allRelays` for the cases the module doc lists.
 */
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
