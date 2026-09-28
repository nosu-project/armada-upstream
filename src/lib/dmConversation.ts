/**
 * The one place a NIP-17 conversation's route param, name and participants
 * are composed, so list rows, headers and the switcher agree. Route params
 * are npubs joined per participant (a 1:1 is the old `/dm/<npub>` shape).
 */

import { nip19 } from "nostr-tools";

import { getDisplayName } from "@/lib/getDisplayName";
import { DM_PEER_SEP, dmConvKey, dmConvPeers } from "@/lib/nip17/protocol";
import { resolvePubkey } from "@/lib/resolvePubkey";

import type { NostrMetadata } from "@nostrify/nostrify";

/** URL segment for a conversation: every participant as an npub (the set IS its identity). */
export function dmRouteParam(key: string): string {
  return dmConvPeers(key)
    .map((peer) => nip19.npubEncode(peer))
    .join(DM_PEER_SEP);
}

/**
 * Parse a `/dm/:peer` param into a canonical conversation key, or undefined.
 * Re-sorted so different orderings aren't different conversations.
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

export function dmParticipantNames(
  peers: readonly string[],
  metadata: (pubkey: string) => NostrMetadata | undefined,
): string[] {
  return peers.map((peer) => getDisplayName(metadata(peer), peer));
}

/**
 * Conversation title: all names comma-joined; not truncated here (CSS
 * `truncate` elides to the available width).
 */
export function dmConversationName(names: readonly string[]): string {
  return names.join(", ");
}

/** Searchable identity text: names, display names, NIP-05, hex and npub of every participant. */
export function dmConversationSearchText(
  peers: readonly string[],
  metadata: (pubkey: string) => NostrMetadata | undefined,
): string {
  const terms: string[] = [];
  for (const peer of peers) {
    const profile = metadata(peer);
    for (const value of [profile?.name, profile?.display_name, profile?.nip05, peer]) {
      const term = value?.trim();
      if (term) terms.push(term);
    }
    try {
      terms.push(nip19.npubEncode(peer));
    } catch {
      // A malformed synced setting just loses its npub alias.
    }
  }
  return terms.join(" ");
}
