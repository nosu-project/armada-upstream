/**
 * Invite discovery — the community announcement event.
 *
 * CORD-05 invites are private by construction: the unlock token lives only in a
 * URL `#fragment`, and the kind-33301 bundle is NIP-44-encrypted with a key
 * derived from it. Nothing an invite touches is searchable on its own.
 *
 * "Share to Discover" publishes a community announcement: a REGULAR kind-3314
 * event, signed by the sharer's real key, whose content is the full shareable
 * invite link (`https://…/invite/naddr1…#fragment`, secret included) and
 * nothing else — no tags, no metadata. Name, icon, banner and channels all
 * come from the invite bundle the link resolves to, which the creator
 * refreshes as the community changes — so a listing never goes stale, it just
 * tracks the bundle. Even the community's identity is learned only by
 * resolving the bundle: a tag would be an unverifiable claim (nothing binds
 * it to the link), whereas the bundle's `community_id` self-certifies. The
 * link carries the secret, so anyone who finds the announcement can join —
 * publishing one is always an explicit user action.
 *
 * This is an Armada client convention, not a CORD kind: the event is bare
 * (never wrapped) and carries no Concord key material beyond what the shared
 * link itself already discloses. It lives here, not in the frozen CORD-02
 * registry (which ends at 3313).
 */

import { parseInviteLink } from "@/concord-v2/lib/invite";

import type { EventTemplate } from "@/hooks/useNostrPublish";
import type { NostrRumor } from "@/lib/nostrRumor";

/** Community announcement: regular event, the invite link as the content. */
export const KIND_COMMUNITY_ANNOUNCEMENT = 3314;

/** An invite link mined from a community announcement. */
export interface DiscoveredInvite {
  /** The full shareable invite URL (fragment included). */
  inviteUrl: string;
  /**
   * The link-signer pubkey — the invite's coordinate author, and the
   * de-duplication key across announcements. Which COMMUNITY the link leads
   * to is only known after resolving its bundle (the `community_id` there
   * self-certifies), so cross-link duplicates of one community are folded at
   * the rendering layer, not here.
   */
  linkSigner: string;
  /** The announcement event that carried the link. */
  source: NostrRumor;
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
 * null when it isn't usable: the content must carry a valid, secret-carrying
 * invite link.
 */
export function announcementFromEvent(event: NostrRumor): DiscoveredInvite | null {
  const [url] = extractInviteUrls(event.content);
  if (!url) return null;
  const parsed = parseInviteLink(url);
  if (!parsed) return null;
  return { inviteUrl: url, linkSigner: parsed.linkSigner, source: event };
}

/**
 * Build the community announcement "share to Discover" publishes: the invite
 * URL as the content, nothing else — the community's identity and all display
 * metadata are resolved live from the link's bundle. Returns null if the URL
 * isn't a valid invite link.
 */
export function buildCommunityAnnouncement(input: { inviteUrl: string }): EventTemplate | null {
  if (!parseInviteLink(input.inviteUrl)) return null;
  return {
    kind: KIND_COMMUNITY_ANNOUNCEMENT,
    content: input.inviteUrl.trim(),
    tags: [],
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
