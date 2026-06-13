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
