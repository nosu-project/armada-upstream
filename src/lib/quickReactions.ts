/**
 * NIP-51 quick reactions (kind 10077): the reactions a client offers first, in
 * the user's order. Each `reaction` tag is a NIP-25 `.content`, plus the image
 * URL and optional emoji-set address of a custom `:shortcode:` emoji.
 */

import { sanitizeImageSrc } from "@/lib/sanitizeUrl";

import type { NostrRumor } from "@/lib/nostrRumor";

/** A reaction on the quick row; `url` (and `set`) only for a custom `:shortcode:` emoji. */
export interface QuickReaction {
  key: string;
  url?: string;
  /** The `30030:pubkey:d` emoji set the custom emoji came from. */
  set?: string;
}

/** The list's reactions in order, first occurrence of each key kept. */
export function parseQuickReactions(event: Pick<NostrRumor, "tags"> | null | undefined): QuickReaction[] {
  if (!event) return [];
  const out: QuickReaction[] = [];
  const seen = new Set<string>();
  for (const [name, key, rawUrl, set] of event.tags) {
    if (name !== "reaction" || !key || seen.has(key)) continue;
    seen.add(key);
    const url = sanitizeImageSrc(rawUrl);
    out.push(url ? (set ? { key, url, set } : { key, url }) : { key });
  }
  return out;
}

/** `reaction` tags for `reactions`, in order. */
export function quickReactionTags(reactions: readonly QuickReaction[]): string[][] {
  return reactions.map(({ key, url, set }) =>
    url ? (set ? ["reaction", key, url, set] : ["reaction", key, url]) : ["reaction", key]);
}

/**
 * The next version's tags: `prev`'s other tags kept (another client's items
 * survive), its reactions replaced. The publisher stamps its own `client`.
 */
export function nextQuickReactionTags(
  prev: Pick<NostrRumor, "tags"> | null | undefined,
  reactions: readonly QuickReaction[],
): string[][] {
  const kept = prev?.tags.filter(([name]) => name !== "reaction" && name !== "client") ?? [];
  return [...kept.map((t) => [...t]), ...quickReactionTags(reactions)];
}
