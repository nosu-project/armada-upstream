import data from "@emoji-mart/data";

interface EmojiMartData {
  emojis: Record<string, { skins?: Array<{ native?: string }> }>;
  aliases: Record<string, string>;
}

/**
 * Index of the `:` that opens an in-progress `:shortcode` query ending at
 * `cursor`, or -1 if there isn't one.
 *
 * A colon starts a shortcode when it sits at the beginning of the text or
 * after anything that is not a shortcode character (`[A-Za-z0-9_]`). That
 * keeps `http://` / `3:30` / `word:foo` from matching, while still allowing
 * back-to-back native emojis (`👍:smile`) without a required space — the
 * previous whitespace-only rule rejected those.
 */
export function findEmojiShortcodeColon(value: string, cursor: number): number {
  for (let i = cursor - 1; i >= 0; i--) {
    const ch = value[i];
    if (ch === " " || ch === "\n" || ch === "\t") break;
    if (ch === ":" && i < cursor - 1) {
      if (i === 0 || !/[A-Za-z0-9_]/.test(value[i - 1]!)) return i;
      break;
    }
  }
  return -1;
}

/**
 * The native emoji a shortcode names exactly — an emoji-mart id (`v`, `tm`,
 * `+1`) or one of its aliases (`thumbsup`) — or undefined. Case-insensitive,
 * since every id in the data is lower case.
 */
export function nativeEmojiForShortcode(name: string): string | undefined {
  const { emojis, aliases } = data as EmojiMartData;
  const key = name.toLowerCase();
  if (!Object.hasOwn(emojis, key) && !Object.hasOwn(aliases, key)) return undefined;
  const id = Object.hasOwn(emojis, key) ? key : aliases[key]!;
  return emojis[id]?.skins?.[0]?.native;
}

/**
 * The replacement for a `:shortcode:` whose closing colon sits just before
 * `cursor` — i.e. the one the user has just finished typing — or null when
 * there is nothing to convert. The composer applies it as the closing colon is
 * typed, so `:v:` becomes ✌️ in the input itself. The opening colon follows the same rule as the
 * autocomplete (`findEmojiShortcodeColon`), so `3:30:` or `http://a:` never
 * match. A name in `customShortcodes` is left alone: `:name:` is how a NIP-30
 * custom emoji is written, and converting it would swap it for an unrelated
 * native one.
 */
export function completedShortcodeAt(
  value: string,
  cursor: number,
  customShortcodes: ReadonlySet<string> = new Set(),
): { start: number; end: number; replacement: string } | null {
  if (cursor < 3 || value[cursor - 1] !== ":") return null;
  const start = findEmojiShortcodeColon(value, cursor - 1);
  if (start < 0) return null;
  const name = value.slice(start + 1, cursor - 1);
  if (!/^[A-Za-z0-9_+-]+$/.test(name)) return null;
  if (customShortcodes.has(name)) return null;
  const native = nativeEmojiForShortcode(name);
  return native ? { start, end: cursor, replacement: native } : null;
}
