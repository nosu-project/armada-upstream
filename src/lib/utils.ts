import { clsx, type ClassValue } from "clsx"
import { twMerge } from "tailwind-merge"

export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs))
}

/**
 * Pick which channel/room to open by default for a server or community.
 *
 * Preference order:
 *   1. The persisted last-opened channel (`storedId`), if it still exists.
 *   2. A channel literally named "general" (case-insensitive).
 *   3. The first channel.
 *
 * `idOf` and `nameOf` extract the id/name from each entry so this works for
 * both NIP-29 groups (`id`/`name` strings) and Concord channels (bytes id →
 * hex). Returns `undefined` only when `channels` is empty.
 */
export function pickDefaultChannel<T>(
  channels: readonly T[],
  storedId: string | undefined,
  idOf: (c: T) => string,
  nameOf: (c: T) => string,
): T | undefined {
  if (channels.length === 0) return undefined;
  if (storedId) {
    const stored = channels.find((c) => idOf(c) === storedId);
    if (stored) return stored;
  }
  const general = channels.find((c) => nameOf(c).trim().toLowerCase() === "general");
  return general ?? channels[0];
}
