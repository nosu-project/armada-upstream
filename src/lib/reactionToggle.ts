import type { ReactInput, ReactionTally } from "@/hooks/useReactions";

/** Quick-reaction slots on the desktop hover toolbar. */
export const QUICK_SLOTS_POINTER = 3;

/** Quick-reaction slots atop the right-click menu (its width, beside the picker button). */
export const QUICK_SLOTS_MENU = 5;

/** Quick-reaction slots in the touch action sheet (a full row, so more than desktop). */
export const QUICK_SLOTS_SHEET = 6;

/**
 * Publish input for reacting with `key`. Always a toggle: an existing reaction
 * with this key is retracted instead of publishing a duplicate kind 7.
 */
export function toggleInput(
  key: string,
  url: string | undefined,
  tallies: ReactionTally[],
): ReactInput {
  const existing = tallies.find((t) => t.key === key);
  return {
    key,
    content: key === "👍" ? "+" : key,
    emojiUrl: url ?? existing?.url,
    mineEventId: existing?.mine ? existing.mineEventId : undefined,
  };
}
