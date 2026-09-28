/**
 * Hashtag pattern (no flags, for embedding in larger regexes): Unicode
 * letters/numbers/underscores with internal hyphens only, so `#nostr-` → `#nostr`.
 */
export const HASHTAG_PATTERN = '#[\\p{L}\\p{N}_](?:[\\p{L}\\p{N}_-]*[\\p{L}\\p{N}_])?';

export function hashtagRegex(): RegExp {
  return new RegExp(HASHTAG_PATTERN, 'gu');
}

/** Lowercase `t` tag values (without `#`) for hashtags in `content`. */
export function extractHashtags(content: string): string[] {
  return content.match(hashtagRegex())?.map((h) => h.slice(1).toLowerCase()) ?? [];
}
