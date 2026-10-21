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

/** GitWorkshop page for a repository announcement. */
export function gitworkshopRepositoryUrl(owner: string, identifier: string, relayHint?: string): string | undefined {
  try {
    return `${GITWORKSHOP_ORIGIN}${gitworkshopRepositoryPath(nip19.npubEncode(owner), identifier, relayHint)}`;
  } catch {
    return undefined;
  }
}

/**
 * ngit's `nostr://<npub>[/<relay>]/<identifier>` remote. Only a bare wss host
 * becomes the relay segment; anything else is left out rather than mis-spelled,
 * since the remote resolves without one.
 */
export function ngitCloneUrl(owner: string, identifier: string, relayHint?: string): string | undefined {
  let npub: string;
  try {
    npub = nip19.npubEncode(owner);
  } catch {
    return undefined;
  }
  const relay = relayHint ? normalizeRelayUrl(relayHint) : undefined;
  const host = relay?.startsWith("wss://") ? relay.slice("wss://".length).replace(/\/$/, "") : undefined;
  const relaySegment = host && /^[a-z0-9.-]+(:\d+)?$/i.test(host) ? `${host}/` : "";
  return `nostr://${npub}/${relaySegment}${encodeURIComponent(identifier)}`;
}
