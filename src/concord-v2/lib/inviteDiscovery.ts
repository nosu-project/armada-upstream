/**
 * Invite discovery — the community announcement event.
 *
 * CORD-05 invites are private by construction: the unlock token lives only in a
 * URL `#fragment`, and the kind-33301 bundle is NIP-44-encrypted with a key
 * derived from it. Nothing an invite touches is searchable on its own.
 *
 * "Share to Discover" publishes a community announcement: an addressable
 * kind-33302 event, signed by the sharer's real key, whose `d` tag is the
 * community id and whose content carries the full shareable invite link
 * (`https://…/invite/naddr1…#fragment`, secret included) plus an optional
 * blurb. Addressability means re-sharing REPLACES the sharer's previous
 * listing for that community instead of piling up notes, and un-listing is a
 * future replace. The link carries the secret, so anyone who finds the
 * announcement can join — publishing one is always an explicit user action.
 *
 * This is an Armada client convention, not a CORD kind: the event is bare
 * (never wrapped) and carries no Concord key material beyond what the shared
 * link itself already discloses. It lives here, not in the frozen CORD-02
 * registry.
 */

import { parseInviteLink } from "@/concord-v2/lib/invite";

import type { EventTemplate } from "@/hooks/useNostrPublish";
import type { NostrRumor } from "@/lib/nostrRumor";

/** Community announcement: addressable, `d` = community id (hex). */
export const KIND_COMMUNITY_ANNOUNCEMENT = 33302;

/** A community id as it appears in a `d` tag: 32 bytes of lowercase hex. */
const COMMUNITY_ID_RE = /^[0-9a-f]{64}$/;

/** An invite link mined from a community announcement. */
export interface DiscoveredInvite {
  /** The full shareable invite URL (fragment included). */
  inviteUrl: string;
  /** The link-signer pubkey — the invite's coordinate author. */
  linkSigner: string;
  /** The announced community's id (the announcement's `d` tag, hex). */
  communityId: string;
  /** The plaintext name the sharer chose to list under, if any. */
  name?: string;
  /** The announcement event that carried the link. */
  source: NostrRumor;
}

/** Normalize a topic to a bare, lowercase hashtag body. */
function normalizeTopic(topic: string): string {
  return topic.trim().replace(/^#+/, "").toLowerCase();
}

/**
 * Matches a full invite URL (`https://…/invite/naddr1…#fragment`) or the bare
 * `naddr1…#fragment` form embedded in free text. The naddr body is bech32
 * (lowercase a-z0-9); the fragment is base64url.
 */
const INVITE_URL_RE =
  /(?:https?:\/\/[^\s]+?\/invite\/naddr1[0-9a-z]+#[A-Za-z0-9_-]+)|(?:naddr1[0-9a-z]+#[A-Za-z0-9_-]+)/gi;

/**
 * Extract every valid, secret-carrying invite link found in free text,
 * de-duplicated by link-signer (so one link mentioned twice yields one entry).
 */
export function extractInviteUrls(text: string): string[] {
  const matches = text.match(INVITE_URL_RE);
  if (!matches) return [];
  const out: string[] = [];
  const seen = new Set<string>();
  for (const m of matches) {
    const parsed = parseInviteLink(m);
    if (!parsed || seen.has(parsed.linkSigner)) continue;
    seen.add(parsed.linkSigner);
    out.push(m);
  }
  return out;
}

/**
 * Read one community announcement event into a {@link DiscoveredInvite}, or
 * null when it isn't usable: the `d` tag must be a community id and the
 * content must carry a valid, secret-carrying invite link.
 */
export function announcementFromEvent(event: NostrRumor): DiscoveredInvite | null {
  const d = event.tags.find(([n]) => n === "d")?.[1] ?? "";
  if (!COMMUNITY_ID_RE.test(d)) return null;
  const [url] = extractInviteUrls(event.content);
  if (!url) return null;
  const parsed = parseInviteLink(url);
  if (!parsed) return null;
  const name = event.tags.find(([n]) => n === "name")?.[1]?.trim();
  return {
    inviteUrl: url,
    linkSigner: parsed.linkSigner,
    communityId: d,
    ...(name ? { name } : {}),
    source: event,
  };
}

/**
 * The announcement's content minus the invite URL — the sharer's blurb for the
 * card (e.g. "A place to talk sailing"). Collapses whitespace.
 */
export function inviteSourceBlurb(event: NostrRumor): string {
  return event.content
    .replace(INVITE_URL_RE, "")
    .replace(/\s+/g, " ")
    .trim();
}

/**
 * Build the community announcement "share to Discover" publishes. The invite
 * URL rides in the content (where NIP-50 search indexes it), the community id
 * is the `d` tag (so a re-share replaces the sharer's previous listing), and
 * the community name rides in a `name` tag so the listing is searchable
 * without decrypting the bundle. Returns null if the URL isn't a valid invite
 * link or the id isn't a community id.
 */
export function buildCommunityAnnouncement(input: {
  communityId: string;
  inviteUrl: string;
  name?: string;
  description?: string;
  topics?: string[];
}): EventTemplate | null {
  const communityId = input.communityId.toLowerCase();
  if (!COMMUNITY_ID_RE.test(communityId)) return null;
  if (!parseInviteLink(input.inviteUrl)) return null;
  const topics = (input.topics ?? [])
    .map(normalizeTopic)
    .filter((t) => t.length > 0 && t.length <= 64);
  const blurb = input.description?.trim();
  const name = input.name?.trim();
  const content = [blurb, input.inviteUrl.trim()].filter(Boolean).join("\n\n");
  return {
    kind: KIND_COMMUNITY_ANNOUNCEMENT,
    content,
    tags: [
      ["d", communityId],
      ...(name ? [["name", name]] : []),
      ...topics.map((t) => ["t", t]),
    ],
  };
}

/**
 * Convert a shareable invite URL into a local router path (`/invite/<naddr>#…`)
 * so "Join" navigates in-app rather than doing a full navigation to the hosted
 * origin baked into a native-built link. Falls back to the raw input.
 */
export function inviteUrlToLocalRoute(url: string): string {
  const trimmed = url.trim();
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
