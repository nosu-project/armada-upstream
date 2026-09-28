/**
 * NIP-17 conversation identity and its ArmadaDB term policy. A conversation is
 * its participant set, canonicalized as "everyone but the viewer, sorted", so
 * both directions agree. For 1:1 this is `[peer]` and for Note to Self `[self]`,
 * so {@link dmConvKey} equals the old single-pubkey key — load-bearing for every
 * route, KV key, wire scope and snapshot on disk.
 *
 * Must stay DEPENDENCY-FREE: `db/termPolicies.ts` (bundled into the Electron
 * main process) imports it. `protocol.ts` re-exports everything here.
 */

import type { NostrRumor } from "@/lib/nostrRumor";

/** Participant separator in conversation keys; URL-path-safe so `/dm/<a>,<b>` stays readable. */
export const DM_PEER_SEP = ",";

/**
 * Whether `value` is a lowercase-hex 32-byte pubkey. Non-pubkey `p` values are
 * dropped when building sets: keys, terms (fixed-width concatenation) and routes rely on it.
 */
function isPubkey(value: string): boolean {
  return /^[0-9a-f]{64}$/.test(value);
}

/**
 * The rumor's participants from `self`'s view (everyone but the viewer, sorted;
 * `[self]` for Note to Self). Undefined when unattributable (e.g. own copy with no `p`).
 */
export function dmPeersOf(
  rumor: { pubkey: string; tags: string[][] },
  self: string,
): string[] | undefined {
  const recipients = new Set<string>();
  for (const [name, value] of rumor.tags) {
    if (name === "p" && value && isPubkey(value)) recipients.add(value);
  }

  if (rumor.pubkey !== self) {
    // Received: the sender is a participant; hold it to the pubkey shape too.
    if (!isPubkey(rumor.pubkey)) return undefined;
    const others = new Set(recipients);
    others.add(rumor.pubkey);
    others.delete(self);
    return others.size === 0 ? undefined : [...others].sort();
  }

  // Our own copy: only the `p` set says where it went.
  if (recipients.size === 0) return undefined;
  const others = new Set(recipients);
  others.delete(self);
  return others.size === 0 ? [self] : [...others].sort();
}

/** Stable key for a participant set; for 1:1 just the peer's pubkey (see module note). */
export function dmConvKey(peers: readonly string[]): string {
  return peers.join(DM_PEER_SEP);
}

/** The participants a conversation key names. Inverse of {@link dmConvKey}. */
export function dmConvPeers(key: string): string[] {
  return key.split(DM_PEER_SEP).filter(Boolean);
}

/** Whether a conversation key names more than one other participant. */
export function isDmGroupKey(key: string): boolean {
  return key.includes(DM_PEER_SEP);
}

/** The conversation key a rumor belongs to, or undefined when unattributable. */
export function dmConvKeyOf(
  rumor: { pubkey: string; tags: string[][] },
  self: string,
): string | undefined {
  const peers = dmPeersOf(rumor, self);
  return peers && dmConvKey(peers);
}

/** The NIP-50 extension key a conversation is looked up by. */
export const DM_CONV_TERM = "conv";

/**
 * Namespace holding only listable rumors (chat/file), so `distinct:convmsg` can
 * find each conversation's newest message without reading a row per index entry.
 */
export const DM_MSG_TERM = "convmsg";

/**
 * Same, restricted to messages the viewer sent. Must be COMPLETE: push gateways
 * use it to decide a sender isn't a stranger.
 */
export const DM_MINE_TERM = "convmine";

/**
 * Kinds {@link DM_MSG_TERM} covers, duplicated to stay dependency-free;
 * `dm17Store.test.ts` asserts they match `protocol.ts`.
 */
export const DM_MESSAGE_KINDS: readonly number[] = [14, 15];

/**
 * Index term for a conversation. Participants are concatenated (not
 * {@link DM_PEER_SEP}-joined) because terms cross a whitespace-tokenized NIP-50
 * string; fixed-width hex keeps it unambiguous and inside `[0-9a-f]`.
 */
export function dmConvTerm(peers: readonly string[], namespace = DM_CONV_TERM): string {
  return `${namespace}:${[...peers].sort().join("")}`;
}

/** Kind-3310 WebXDC update (CORD-02 Appendix B); excluded from the list and notifications. */
function isWebxdcUpdate(rumor: NostrRumor): boolean {
  return rumor.kind === 3310;
}

/**
 * `TermPolicy` for a `dm17:<self>` tenant: one term per qualifying namespace
 * (`distinct:` requires exactly one). `self` comes from the tenant id.
 * Unattributable rumors get no term.
 */
export function dmTermPolicy(rumor: NostrRumor, tenantId: string): string[] {
  const self = dm17TenantSelf(tenantId);
  if (!self) return [];
  const peers = dmPeersOf(rumor, self);
  if (!peers) return [];

  const terms = [dmConvTerm(peers)];
  if (DM_MESSAGE_KINDS.includes(rumor.kind) && !isWebxdcUpdate(rumor)) {
    terms.push(dmConvTerm(peers, DM_MSG_TERM));
    if (rumor.pubkey === self) terms.push(dmConvTerm(peers, DM_MINE_TERM));
  }
  return terms;
}

/** The `dm17:` tenant prefix, and the viewer a tenant id names. */
export const DM17_TENANT_PREFIX = "dm17:";

/** The pubkey in a `dm17:<self>` tenant id, or `undefined` for any other id. */
export function dm17TenantSelf(tenantId: string): string | undefined {
  return tenantId.startsWith(DM17_TENANT_PREFIX)
    ? tenantId.slice(DM17_TENANT_PREFIX.length)
    : undefined;
}
