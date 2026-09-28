import { clsx, type ClassValue } from "clsx"
import { twMerge } from "tailwind-merge"

export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs))
}

/**
 * Default channel for a server/community: the stored last-opened one if it
 * still exists, else one named "general", else the first.
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
