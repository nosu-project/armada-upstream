/**
 * Invite discovery — finding public Concord communities WITHOUT inventing any
 * new event kind.
 *
 * CORD-05 invites are private by construction: the unlock token lives only in a
 * URL `#fragment`, and the kind-33301 bundle is NIP-44-encrypted with a key
 * derived from it. Nothing an invite touches is searchable on its own.
 *
 * But people already make communities discoverable the plain Nostr way — they
 * post the full shareable link (`https://…/invite/naddr1…#fragment`) in an
 * ordinary note. Those links carry the secret, so anyone who finds the note can
 * join. Discovery therefore just NIP-50-searches notes for invite links and
 * pulls them out; "share to Discover" is nothing more than publishing such a
 * note. No bespoke directory kind, no new convention.
 */

import { parseInviteLink } from "@/concord-v2/lib/invite";

import type { EventTemplate } from "@/hooks/useNostrPublish";
import type { NostrEvent } from "@nostrify/nostrify";

/**
 * The NIP-50 anchor Discovery searches for: the default share origin baked into
 * every hosted/native build (`shareOrigin()` → armada.buzz). The overwhelming
 * majority of shared links contain it, and searching a concrete string keeps
 * the query tight instead of drowning in unrelated notes.
 */
export const SHARE_MARKER = "armada.buzz/invite";

/** An invite link mined from a public event. */
export interface DiscoveredInvite {
  /** The full shareable invite URL (fragment included). */
  inviteUrl: string;
  /** The link-signer pubkey — the de-duplication key across notes. */
  linkSigner: string;
  /** The event that carried the link (a note, usually). */
  source: NostrEvent;
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

/** Pull the discoverable invites out of one event's content. */
export function invitesFromEvent(event: NostrEvent): DiscoveredInvite[] {
  const out: DiscoveredInvite[] = [];
  for (const url of extractInviteUrls(event.content)) {
    const parsed = parseInviteLink(url);
    if (!parsed) continue;
    out.push({ inviteUrl: url, linkSigner: parsed.linkSigner, source: event });
  }
  return out;
}

/**
 * The event content minus any invite URLs — a human blurb for the card (e.g.
 * "Created a Bitcoin community, join the party"). Collapses whitespace.
 */
export function inviteSourceBlurb(event: NostrEvent): string {
  return event.content
    .replace(INVITE_URL_RE, "")
    .replace(/\s+/g, " ")
    .trim();
}

/**
 * Build the note that "share to Discover" publishes: an ordinary kind-1 post
 * carrying the invite link (so the NIP-50 search finds it), an optional blurb,
 * and topic hashtags. Returns null if the URL isn't a valid invite link.
 */
export function buildInviteAnnouncementNote(input: {
  inviteUrl: string;
  description?: string;
  topics?: string[];
}): EventTemplate | null {
  if (!parseInviteLink(input.inviteUrl)) return null;
  const topics = (input.topics ?? [])
    .map(normalizeTopic)
    .filter((t) => t.length > 0 && t.length <= 64);
  const blurb = input.description?.trim();
  const hashtags = topics.map((t) => `#${t}`).join(" ");
  const content = [blurb, input.inviteUrl.trim(), hashtags].filter(Boolean).join("\n\n");
  return { kind: 1, content, tags: topics.map((t) => ["t", t]) };
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
