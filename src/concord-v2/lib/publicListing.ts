/**
 * Public community listings — an OPT-IN, Armada-client directory convention
 * (NOT a CORD spec kind).
 *
 * CORD-05 invites are private by construction: the unlock token lives only in a
 * URL `#fragment` and never reaches a relay, and the kind-33301 bundle at the
 * link-signer coordinate is NIP-44-encrypted with a key derived from that
 * off-relay token. So nothing an invite touches is globally searchable.
 *
 * A public listing is the escape hatch a community owner can choose per link:
 * a plaintext, NIP-50-indexable event that embeds the FULL shareable invite URL
 * (fragment included). Publishing one deliberately trades the link's secrecy for
 * discoverability — anyone who finds the listing can join. It is only ever
 * written on an explicit user action (the "List in Discover" toggle), one
 * addressable event per link (keyed by the link-signer pubkey), and is removed
 * when the link is revoked.
 */

import { isInviteUrl, parseInviteLink } from "@/concord-v2/lib/invite";

import type { EventTemplate } from "@/hooks/useNostrPublish";
import type { NostrEvent } from "@nostrify/nostrify";

/**
 * Addressable public community listing (Armada convention). One per invite
 * link, `d` = the link-signer pubkey. `content` carries the searchable text
 * (name + description) so NIP-50 relays index it; the full invite URL rides an
 * `r` tag.
 */
export const KIND_PUBLIC_COMMUNITY = 30456;

/** Marker `t` topics every Armada listing carries, for kind-agnostic filtering. */
export const LISTING_MARKER_TOPICS = ["concord", "armada"] as const;

/** A parsed public community listing. */
export interface PublicListing {
  /** The listing event's author (the community owner who published it). */
  author: string;
  /** The link-signer pubkey (the listing's `d` identifier). */
  linkSigner: string;
  /** The full shareable invite URL, fragment included. */
  inviteUrl: string;
  /** Community display name. */
  name: string;
  /** Optional description. */
  description?: string;
  /** Optional icon URL. */
  icon?: string;
  /** User-supplied topics (excludes the internal marker topics). */
  topics: string[];
  /** The underlying event. */
  event: NostrEvent;
}

/** Fields a listing is built from. */
export interface BuildListingInput {
  inviteUrl: string;
  name: string;
  description?: string;
  icon?: string;
  topics?: string[];
}

/** Normalize a topic to a bare, lowercase hashtag body. */
function normalizeTopic(topic: string): string {
  return topic.trim().replace(/^#+/, "").toLowerCase();
}

/**
 * Build a public community listing event for an invite URL. Returns null if the
 * URL isn't a recognizable, secret-carrying V2 invite link (a listing with no
 * usable link would be a dead directory entry).
 */
export function buildPublicListingEvent(input: BuildListingInput): EventTemplate | null {
  const parsed = parseInviteLink(input.inviteUrl);
  if (!parsed) return null;

  const name = input.name.trim() || "Encrypted community";
  const description = input.description?.trim() || "";
  const userTopics = (input.topics ?? [])
    .map(normalizeTopic)
    .filter((t) => t.length > 0 && t.length <= 64);

  // Deduplicate user topics, then append the internal markers.
  const topicSet = new Set(userTopics);
  const markerSet = new Set<string>(LISTING_MARKER_TOPICS);

  const tags: string[][] = [
    ["d", parsed.linkSigner],
    ["title", name],
    ["name", name],
    ["r", input.inviteUrl.trim()],
  ];
  if (description) tags.push(["summary", description]);
  if (input.icon?.trim()) tags.push(["image", input.icon.trim()]);
  for (const t of topicSet) {
    tags.push(["t", t]);
    markerSet.delete(t);
  }
  for (const t of markerSet) tags.push(["t", t]);

  // Searchable plaintext for NIP-50: name, description, and topics.
  const content = [name, description, [...topicSet].map((t) => `#${t}`).join(" ")]
    .filter(Boolean)
    .join("\n");

  return { kind: KIND_PUBLIC_COMMUNITY, content, tags };
}

/** The addressable coordinate of a listing (`30456:owner:linkSigner`). */
export function listingCoord(owner: string, linkSigner: string): string {
  return `${KIND_PUBLIC_COMMUNITY}:${owner}:${linkSigner}`;
}

/**
 * Parse a kind-30456 event into a PublicListing. Returns null when the event is
 * malformed or its embedded URL isn't a valid invite link (a revoked/tombstoned
 * listing carries no `r` tag and so parses to null, which drops it from feeds).
 */
export function parsePublicListing(event: NostrEvent): PublicListing | null {
  if (event.kind !== KIND_PUBLIC_COMMUNITY) return null;

  const linkSigner = event.tags.find(([n]) => n === "d")?.[1];
  if (!linkSigner) return null;

  const inviteUrl = event.tags.find(([n]) => n === "r")?.[1]?.trim();
  if (!inviteUrl || !isInviteUrl(inviteUrl)) return null;
  // The URL must actually carry the secret fragment, else "Join" is a dead end.
  if (!parseInviteLink(inviteUrl)) return null;

  const name =
    event.tags.find(([n]) => n === "title")?.[1]?.trim() ||
    event.tags.find(([n]) => n === "name")?.[1]?.trim() ||
    "Encrypted community";
  const description =
    event.tags.find(([n]) => n === "summary")?.[1]?.trim() ||
    event.tags.find(([n]) => n === "description")?.[1]?.trim() ||
    undefined;
  const icon = event.tags.find(([n]) => n === "image")?.[1]?.trim() || undefined;

  const marker = new Set<string>(LISTING_MARKER_TOPICS);
  const topics = event.tags
    .filter((t) => t[0] === "t" && t[1])
    .map((t) => normalizeTopic(t[1]))
    .filter((t) => t.length > 0 && !marker.has(t));

  return {
    author: event.pubkey,
    linkSigner,
    inviteUrl,
    name,
    description,
    icon,
    topics: [...new Set(topics)],
    event,
  };
}

/**
 * Convert a shareable invite URL into a local router path (`/invite/<naddr>#…`)
 * so "Join" navigates in-app rather than doing a full navigation to the hosted
 * origin (armada.buzz) baked into a native-built link. Falls back to the raw
 * input when it can't be reshaped.
 */
export function inviteUrlToLocalRoute(url: string): string {
  const trimmed = url.trim();
  // Full URL form: keep just the path + fragment (drop the origin).
  try {
    const u = new URL(trimmed);
    if (u.pathname.startsWith("/invite/")) return `${u.pathname}${u.hash}`;
  } catch {
    // Not an absolute URL — fall through to the bare naddr#fragment form.
  }
  const m = /^(naddr1[a-z0-9]+)#(.+)$/i.exec(trimmed);
  if (m) return `/invite/${m[1]}#${m[2]}`;
  return trimmed;
}
