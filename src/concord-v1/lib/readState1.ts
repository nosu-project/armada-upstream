/**
 * Concord V1 per-channel read state — the exact model V2 uses (readState2.ts):
 * per (user, channel), the unix-SECONDS `created_at` of the newest message the
 * user has seen, persisted in the shared Concord IndexedDB KV cache. Unread is
 * computed purely from the local event store the wire keeps fed; no relay
 * query is made just to light a badge.
 */

import { readFolded, writeFolded } from "@/lib/foldedCache";

/** A per-channel last-read map: channelIdHex → newest-seen unix SECONDS. */
export type Concord1ReadMap = Record<string, number>;

/** KV key for one user's V1 read state. */
function readStateKey(userPubkey: string): string {
  return `concord1-read:${userPubkey}`;
}

/** Load the whole per-user read map (empty on miss / no IndexedDB). */
export async function loadConcord1ReadState(userPubkey: string): Promise<Concord1ReadMap> {
  const map = await readFolded<Concord1ReadMap>(readStateKey(userPubkey));
  return map ?? {};
}

/**
 * Mark a channel read up to `timestamp` (unix SECONDS). Monotonic: never
 * rewinds a channel to an older stamp. Returns the updated map (the same
 * reference if nothing changed).
 */
export async function markConcord1Read(
  userPubkey: string,
  channelIdHex: string,
  timestamp: number,
): Promise<Concord1ReadMap> {
  const map = await loadConcord1ReadState(userPubkey);
  if ((map[channelIdHex] ?? 0) >= timestamp) return map;
  const next = { ...map, [channelIdHex]: timestamp };
  await writeFolded(readStateKey(userPubkey), next);
  return next;
}
