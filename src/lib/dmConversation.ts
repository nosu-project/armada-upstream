/**
 * Presenting a NIP-17 conversation: its route param, its name, and who is in
 * it.
 *
 * A conversation is a participant SET (see `dmPeersOf`), so everything a 1:1
 * got from one profile — the title, the avatar, the composer placeholder — a
 * group has to compose from several. This module is the one place that
 * composition is spelled, so the list row, the thread header and the switcher
 * cannot disagree about what a conversation is called.
 *
 * The route param is npub-encoded per participant, matching what `/dm/<npub>`
 * has always emitted for a 1:1 — so a group link is the same shape, just
 * longer, and a hex key pasted by hand still resolves (see `parseDmRouteParam`).
 */

import { nip19 } from "nostr-tools";

import { getDisplayName } from "@/lib/getDisplayName";
import { DM_PEER_SEP, dmConvKey, dmConvPeers } from "@/lib/nip17/protocol";
import { resolvePubkey } from "@/lib/resolvePubkey";

import type { NostrMetadata } from "@nostrify/nostrify";

/**
 * The URL segment for a conversation key: every participant as an npub. Long
 * for a group (one npub each) and deliberately so — the participant set IS the
 * conversation's identity under NIP-17, so there is nothing shorter to name it
 * by that a cold client could resolve.
 */
export function dmRouteParam(key: string): string {
  return dmConvPeers(key)
    .map((peer) => nip19.npubEncode(peer))
    .join(DM_PEER_SEP);
}

/**
 * Parse a `/dm/:peer` param back into a canonical conversation key, or
 * undefined when any part of it isn't a pubkey.
 *
 * Re-sorted rather than trusted: a hand-written or externally-generated link
 * can list the participants in any order, and two orderings of one conversation
 * must not become two conversations.
 */
export function parseDmRouteParam(param: string | undefined): string | undefined {
  if (!param) return undefined;
  const peers: string[] = [];
  for (const part of param.split(DM_PEER_SEP)) {
    if (!part) continue;
    const pubkey = resolvePubkey(part);
    if (!pubkey) return undefined;
    peers.push(pubkey);
  }
  if (peers.length === 0) return undefined;
  return dmConvKey([...new Set(peers)].sort());
}

/** Display names for a participant set, in the set's own (sorted) order. */
export function dmParticipantNames(
  peers: readonly string[],
  metadata: (pubkey: string) => NostrMetadata | undefined,
): string[] {
  return peers.map((peer) => getDisplayName(metadata(peer), peer));
}

/**
 * The conversation's title: one name for a 1:1, otherwise every participant's
 * name comma-joined — "Derek Ross, Mary Kate Fain".
 *
 * Not truncated to "and N others" here. The row that shows it is one line with
 * `truncate`, so the browser elides at exactly the width available and a
 * narrower pane shows fewer names without this having to guess how many fit.
 */
export function dmConversationName(names: readonly string[]): string {
  return names.join(", ");
}
