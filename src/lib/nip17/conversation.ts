/**
 * NIP-17 conversation identity, and the ArmadaDB term policy that indexes it.
 *
 * A NIP-17 conversation is its PARTICIPANT SET, not a peer. The `p` set defines
 * the room (NIP-17), so a rumor names its own conversation and nothing has to be
 * stored beside it — the same reason the 1:1 partner was always derived rather
 * than injected (see dm17Store's PROVENANCE note).
 *
 * The set is canonicalized to "everyone but the viewer, sorted", which makes the
 * two directions of one conversation agree: a message Alice sends to {me, Bob}
 * reaches me as `pubkey: Alice, p: [me, Bob]` and my reply leaves as
 * `pubkey: me, p: [Alice, Bob]`, and both reduce to [Alice, Bob].
 *
 * For a 1:1 this yields exactly `[peer]` and for Note to Self exactly `[self]`,
 * so {@link dmConvKey} is byte-identical to the old single-pubkey key. That is
 * deliberate and load-bearing: every route, KV key, wire scope, read-state key
 * and thread snapshot on disk keeps working, and no existing conversation is
 * re-filed by the change of rule.
 *
 * NIP-17 gives a group no identity beyond this set, so adding or removing a
 * participant IS a different conversation. There is no fix for that inside the
 * protocol; Concord is where real membership lives.
 *
 * This module is deliberately DEPENDENCY-FREE, and stays that way. It is
 * imported by `db/termPolicies.ts`, which the Electron main process bundles —
 * a process that has no business linking nostr-tools' crypto to file a database
 * row. `protocol.ts` re-exports everything here, so nothing else has to know
 * the split exists.
 */

import type { NostrRumor } from "@/lib/nostrRumor";

/**
 * Separator between participants in a conversation key. A single character
 * that is legal unescaped in a URL path segment, so `/dm/<a>,<b>` stays
 * readable (see `chatRoute`).
 */
export const DM_PEER_SEP = ",";

/**
 * The participants of a rumor's conversation, from `self`'s perspective:
 * everyone involved except the viewer, sorted. `[self]` for Note to Self.
 * Undefined when unattributable — an own copy with no `p` tag names no room,
 * exactly as before, and callers drop it rather than guess.
 */
export function dmPeersOf(
  rumor: { pubkey: string; tags: string[][] },
  self: string,
): string[] | undefined {
  const recipients = new Set<string>();
  for (const [name, value] of rumor.tags) {
    if (name === "p" && value) recipients.add(value);
  }

  if (rumor.pubkey !== self) {
    // Received: the sender is a participant whether or not they p-tagged
    // themselves, and we are not one of our own peers.
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

/**
 * The stable string key for a participant set. For a 1:1 (and Note to Self)
 * this is just the other party's pubkey — see the note above on why that
 * equivalence is not an accident.
 */
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

// ── The term index ───────────────────────────────────────────────────────────

/** The NIP-50 extension key a conversation is looked up by. */
export const DM_CONV_TERM = "conv";

/**
 * The index term for a conversation key.
 *
 * The participants are joined with NOTHING rather than with
 * {@link DM_PEER_SEP}, because a term crosses a NIP-50 search string and the
 * parse ends a token at whitespace — a separator that is merely URL-safe is not
 * enough. Pubkeys are fixed-width 64-char hex, so concatenating them is
 * unambiguous, and the result stays inside `[0-9a-f]`, which is the character
 * class every engine's index can carry verbatim.
 *
 * Note to Self is `[self]` and so is a term like any other; there is no case
 * here that a 1:1 doesn't already cover.
 */
export function dmConvTerm(peers: readonly string[]): string {
  return `${DM_CONV_TERM}:${[...peers].sort().join("")}`;
}

/**
 * The `TermPolicy` for a `dm17:<self>` tenant: each stored rumor filed under
 * the one conversation it belongs to.
 *
 * `self` comes from the TENANT ID, not from anywhere the engine knows — which
 * is the whole shape of the contract. The engines never interpret a term, and
 * this is the layer that spells `dm17:` in the first place.
 *
 * A rumor with no attributable conversation gets no term, and so is invisible
 * to a conversation read. That is correct rather than lossy: it was already
 * invisible, since every reader derived the same key and dropped it.
 */
export function dmTermPolicy(rumor: NostrRumor, tenantId: string): string[] {
  const self = dm17TenantSelf(tenantId);
  if (!self) return [];
  const peers = dmPeersOf(rumor, self);
  return peers ? [dmConvTerm(peers)] : [];
}

/** The `dm17:` tenant prefix, and the viewer a tenant id names. */
export const DM17_TENANT_PREFIX = "dm17:";

/** The pubkey in a `dm17:<self>` tenant id, or `undefined` for any other id. */
export function dm17TenantSelf(tenantId: string): string | undefined {
  return tenantId.startsWith(DM17_TENANT_PREFIX)
    ? tenantId.slice(DM17_TENANT_PREFIX.length)
    : undefined;
}
