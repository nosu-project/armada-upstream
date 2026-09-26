import { nip19 } from "nostr-tools";

import { shareOrigin } from "@/lib/shareOrigin";
import { tryNaddrEncode } from "@/lib/safeNip19";

import type { AddrCoords } from "@/hooks/useEvent";
import type { NostrRumor } from "@/lib/nostrRumor";

/** At most this many relay hints ride in a shared naddr. */
const MAX_RELAY_HINTS = 3;

/** A decoded `naddr`: the event's coordinates plus its relay hints. */
export interface NaddrAddress {
  addr: AddrCoords;
  relays: string[];
}

/**
 * The naddr of an addressable event (30000-39999), or undefined for anything
 * else. Addressed rather than by id so a link keeps pointing at the author's
 * latest edit.
 */
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

/**
 * The in-app path of an naddr's direct view. A bare `/<naddr>` segment, the
 * same NIP-19 convention the profile route (`/<npub>`) and Ditto follow, so
 * the link unfolds in any client that routes one.
 */
export function naddrPath(naddr: string): string {
  return `/${naddr}`;
}

/** The public, shareable URL of an addressable event's direct view. */
export function naddrShareUrl(naddr: string): string {
  return `${shareOrigin()}${naddrPath(naddr)}`;
}

/**
 * Decode a route segment as an naddr. Non-throwing, since it is a URL param:
 * anything that isn't an naddr is null.
 */
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
