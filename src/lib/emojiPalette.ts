/**
 * The durable, per-account copy of the last resolved custom-emoji palette.
 *
 * The React Query cache is in-memory and wiped on every reload, so without a
 * durable floor the picker re-derives from a live two-hop relay read (10030
 * list → 30030 packs) on each load and blanks whenever that read loses its
 * race. This is written by `useCustomEmojis` — not scavenged from the
 * best-effort event cache — so a flaky read can never lose emojis the user has
 * already seen.
 *
 * It is also the reload-surviving evidence that a list EXISTS, which
 * `useEmojiPacks` checks before it will build a kind-10030 list from scratch
 * (AGENTS.md: never build on an empty/failed read when local persisted state
 * says a non-empty list existed).
 *
 * Lives here rather than in either hook because both need it and one already
 * imports the other — previously the storage key was written out twice and
 * kept in sync by hand.
 *
 * ## Why this one stayed in localStorage
 *
 * The unbounded key spaces around it moved to ArmadaDB's KV. This did not, and
 * the reason is the synchronous read: `useCustomEmojis` seeds react-query's
 * `initialData` with it, and `ChatContent` renders message emoji from the
 * result. Behind an async store the palette is empty for the first frame, so
 * every custom emoji in the visible timeline paints as `:shortcode:` and then
 * swaps — on every reload. The quota argument that justified moving the others
 * does not apply here either: this is ONE key per account, bounded by how many
 * packs the user installed, not one per relay or per channel ever touched.
 */

/** The persisted subset of a `CustomEmoji`, as stored. */
import type { CustomEmoji } from "@/hooks/useCustomEmojis";

const KEY_PREFIX = "armada:custom-emojis:";

const paletteKey = (pubkey: string) => `${KEY_PREFIX}${pubkey}`;

/** The stored palette for `pubkey`, or an empty list. */
export function loadPalette(pubkey: string): CustomEmoji[] {
  try {
    const parsed: unknown = JSON.parse(localStorage.getItem(paletteKey(pubkey)) ?? "");
    return Array.isArray(parsed) ? (parsed as CustomEmoji[]) : [];
  } catch {
    return [];
  }
}

/** Replace the stored palette for `pubkey`. */
export function savePalette(pubkey: string, emojis: CustomEmoji[]): void {
  try {
    localStorage.setItem(paletteKey(pubkey), JSON.stringify(emojis));
  } catch {
    // localStorage full/unavailable — the in-memory result still stands.
  }
}

/**
 * Whether this account has a non-empty stored palette — "has it ever had
 * emojis?", across page loads, which the in-memory React Query caches cannot
 * answer since they are empty exactly when a cold-start read is most likely to
 * race out.
 */
export function hasDurableEmojis(pubkey: string): boolean {
  return loadPalette(pubkey).length > 0;
}
