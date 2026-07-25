import type { ReactInput, ReactionTally } from "@/hooks/useReactions";

/** Quick-reaction slots on the desktop hover toolbar. */
export const QUICK_SLOTS_POINTER = 3;

/**
 * Quick-reaction slots in the touch action sheet. The sheet gives them a full
 * row of their own, so it fits more than the desktop strip can.
 */
export const QUICK_SLOTS_SHEET = 6;

/**
 * Build the publish input for reacting with `key`.
 *
 * Reacting is always a TOGGLE against the current tally: if the user already
 * reacted with this key, the existing reaction's event id is carried so the
 * publish path retracts it instead of emitting a second, redundant kind 7.
 * Shared by every surface that can react (pill, hover toolbar, action sheet,
 * picker) so they can't disagree about what a repeat press means.
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
