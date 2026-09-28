/**
 * Durable per-account copy of the last resolved custom-emoji palette, written
 * by `useCustomEmojis` so a flaky relay read never blanks the picker. Also the
 * reload-surviving evidence that a kind-10030 list EXISTS, checked by
 * `useEmojiPacks` before building one (AGENTS.md: never build on an empty read).
 *
 * Stays in localStorage (unlike the KV moves) because it seeds `initialData`
 * synchronously; async would paint every custom emoji as `:shortcode:` on
 * reload. One bounded key per account.
 */

import type { CustomEmoji } from "@/hooks/useCustomEmojis";

const KEY_PREFIX = "armada:custom-emojis:";

const paletteKey = (pubkey: string) => `${KEY_PREFIX}${pubkey}`;

export function loadPalette(pubkey: string): CustomEmoji[] {
  try {
    const parsed: unknown = JSON.parse(localStorage.getItem(paletteKey(pubkey)) ?? "");
    return Array.isArray(parsed) ? (parsed as CustomEmoji[]) : [];
  } catch {
    return [];
  }
}

export function savePalette(pubkey: string, emojis: CustomEmoji[]): void {
  try {
    localStorage.setItem(paletteKey(pubkey), JSON.stringify(emojis));
  } catch {
    // The in-memory result still stands.
  }
}

/** Whether this account has ever had emojis (across reloads; in-memory caches are empty on cold start). */
export function hasDurableEmojis(pubkey: string): boolean {
  return loadPalette(pubkey).length > 0;
}
