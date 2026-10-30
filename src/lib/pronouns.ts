/** Longest pronouns string shown or saved, so a profile can't stretch a layout with it. */
export const MAX_PRONOUNS_LENGTH = 40;

/**
 * The kind-0 `pronouns` string, as Amethyst and Nos write it (proposed for
 * NIP-24 in nostr-protocol/nips#1590). Undefined when absent, blank or not a string.
 */
export function getPronouns(metadata: { [key: string]: unknown } | undefined): string | undefined {
  const raw = metadata?.pronouns;
  if (typeof raw !== "string") return undefined;
  const trimmed = raw.trim();
  return trimmed ? trimmed.slice(0, MAX_PRONOUNS_LENGTH) : undefined;
}
