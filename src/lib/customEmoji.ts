/**
 * NIP-30 custom emoji helpers.
 */

/** Checks if a string is a NIP-30 custom emoji shortcode (`:shortcode:` format). */
export function isCustomEmoji(content: string): boolean {
  return /^:[a-zA-Z0-9_-]+:$/.test(content);
}

/**
 * Extracts the custom emoji URL from an event's tags for a given shortcode.
 * The shortcode should include the colons (e.g., `:soapbox:`).
 */
export function getCustomEmojiUrl(shortcode: string, tags: string[][]): string | undefined {
  const name = shortcode.slice(1, -1);
  const emojiTag = tags.find(([tagName, tagShortcode]) => tagName === "emoji" && tagShortcode === name);
  return emojiTag?.[2];
}

/**
 * Build NIP-30 `["emoji", shortcode, url]` tags for every `:shortcode:` in
 * `content` that matches one of the given custom emojis (one tag per unique
 * shortcode). Shared by the chat composer and the status dialog so anything
 * that publishes user-typed text attaches the same emoji tags.
 */
export function collectEmojiTags(
  content: string,
  emojis: Array<{ shortcode: string; url: string }>,
): string[][] {
  if (emojis.length === 0) return [];
  const emojiMap = new Map(emojis.map((e) => [e.shortcode, e.url]));
  const shortcodeRegex = /:([a-zA-Z0-9_-]+):/g;
  const used = new Set<string>();
  const tags: string[][] = [];
  let match;
  while ((match = shortcodeRegex.exec(content)) !== null) {
    const shortcode = match[1];
    if (emojiMap.has(shortcode) && !used.has(shortcode)) {
      used.add(shortcode);
      tags.push(["emoji", shortcode, emojiMap.get(shortcode)!]);
    }
  }
  return tags;
}

/** Builds a map of shortcode -> URL from an event's emoji tags. */
export function buildEmojiMap(tags: string[][]): Map<string, string> {
  const map = new Map<string, string>();
  for (const tag of tags) {
    if (tag[0] === "emoji" && tag[1] && tag[2]) {
      map.set(tag[1], tag[2]);
    }
  }
  return map;
}
