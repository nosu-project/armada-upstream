import { createContext } from "react";

/** Map of conversation id → last-read timestamp (unix seconds). */
export type ReadStateMap = Record<string, number>;

export interface ReadStateContextType {
  /** The whole read-state map (reactive). */
  readState: ReadStateMap;
  /** Last-read unix timestamp for a conversation, or 0 if never read. */
  getLastRead: (key: string) => number;
  /**
   * Mark a conversation read up to `timestamp` (unix seconds). No-ops if the
   * stored value is already >= timestamp. Persists locally and syncs to the
   * user's encrypted settings (debounced).
   */
  markRead: (key: string, timestamp: number) => void;
  /** Replace the entire map (used when hydrating from synced settings). */
  hydrate: (map: ReadStateMap) => void;
}

/** Stable conversation key for a NIP-29 channel. */
export function channelReadKey(relayUrl: string, groupId: string): string {
  return `${relayUrl}::${groupId}`;
}

/** Stable conversation key for a direct-message thread. */
export function dmReadKey(pubkey: string): string {
  return `dm:${pubkey}`;
}

/** Stable conversation key for a Concord channel. */
export function concordReadKey(channelIdHex: string): string {
  return `c2:${channelIdHex}`;
}

/** Stable key for a Concord community's mentions-tab last-seen stamp. */
export function concordMentionReadKey(communityIdHex: string): string {
  return `c2m:${communityIdHex}`;
}

/** Stable key for a Concord thread's last-read stamp (by root rumor id). */
export function concordThreadReadKey(rootId: string): string {
  return `c2t:${rootId}`;
}

/**
 * Stable key for the direct-invite inbox's last-seen stamp. A single
 * high-water mark for the whole inbox (not per-invite): opening the inbox marks
 * every received invite as seen, so the rail badge clears. The read-state map
 * is synced to the account's own encrypted settings, so this needs no pubkey in
 * the key — a different account reads a different map.
 */
export function concordInviteReadKey(): string {
  return "c2inv";
}

export const ReadStateContext = createContext<ReadStateContextType | undefined>(undefined);
