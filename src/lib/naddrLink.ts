import { nip19 } from "nostr-tools";

import { shareOrigin } from "@/lib/shareOrigin";
import { tryNaddrEncode } from "@/lib/safeNip19";

import type { AddrCoords } from "@/hooks/useEvent";
import type { NostrRumor } from "@/lib/nostrRumor";

/** At most this many relay hints ride in a shared naddr. */
const MAX_RELAY_HINTS = 3;

export interface NaddrAddress {
  addr: AddrCoords;
  relays: string[];
}

/** naddr of an addressable event (30000-39999), else undefined. Addressed so links follow later edits. */
export function eventNaddr(event: NostrRumor, relays: readonly string[] = []): string | undefined {
  if (event.kind < 30000 || event.kind >= 40000) return undefined;
  const identifier = event.tags.find(([n]) => n === "d")?.[1] ?? "";
  return tryNaddrEncode({
    kind: event.kind,
    pubkey: event.pubkey,
    identifier,
    relays: relays.slice(0, MAX_RELAY_HINTS),
  });
}

/** In-app path of an naddr: bare `/<naddr>` (NIP-19 convention, like `/<npub>`). */
export function naddrPath(naddr: string): string {
  return `/${naddr}`;
}

/** The public, shareable URL of an addressable event's direct view. */
export function naddrShareUrl(naddr: string): string {
  return `${shareOrigin()}${naddrPath(naddr)}`;
}

/** Decode a route segment as an naddr, or null (non-throwing). */
export function parseNaddr(segment: string | undefined): NaddrAddress | null {
  if (!segment || !/^naddr1/i.test(segment)) return null;
  try {
    const decoded = nip19.decode(segment.trim());
    if (decoded.type !== "naddr") return null;
    const { kind, pubkey, identifier, relays } = decoded.data;
    return { addr: { kind, pubkey, identifier }, relays: relays ?? [] };
  } catch {
    return null;
  }
}
