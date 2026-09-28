import { nip19 } from "nostr-tools";

import type { GitTicket } from "@/lib/gitActivity";
import { normalizeRelayUrl } from "@/lib/platform";

const GITWORKSHOP_ORIGIN = "https://gitworkshop.dev";

/**
 * One GitWorkshop route segment for a relay. wss relays omit the scheme;
 * ws relays keep a slash-free `ws:` marker.
 */
export function gitworkshopRelaySegment(relayUrl: string): string | undefined {
  const normalized = normalizeRelayUrl(relayUrl);
  if (!normalized) return undefined;
  if (normalized.startsWith("wss://")) {
    return encodeURIComponent(normalized.slice("wss://".length));
  }
  return encodeURIComponent(`ws:${normalized.slice("ws://".length)}`);
}

/** Build a GitWorkshop repository route from independently encoded segments. */
export function gitworkshopRepositoryPath(
  identity: string,
  identifier: string,
  relayHint?: string,
): string {
  const relaySegment = relayHint ? gitworkshopRelaySegment(relayHint) : undefined;
  const repositorySegment = encodeURIComponent(identifier);
  return relaySegment
    ? `/${identity}/${relaySegment}/${repositorySegment}/`
    : `/${identity}/${repositorySegment}/`;
}

/** Build an issue or pull-request link from its NIP-34 repository reference. */
export function gitworkshopTicketUrl(ticket: GitTicket): string | undefined {
  const address = ticket.repositoryAddress;
  if (!address) return undefined;
  try {
    const identity = nip19.npubEncode(address.owner);
    const event = nip19.neventEncode({
      id: ticket.id,
      author: ticket.author,
      kind: ticket.kind,
    });
    const repositoryPath = gitworkshopRepositoryPath(
      identity,
      address.identifier,
      address.relayHint,
    );
    const collection = ticket.type === "issue" ? "issues" : "prs";
    return `${GITWORKSHOP_ORIGIN}${repositoryPath}${collection}/${event}`;
  } catch {
    return undefined;
  }
}
