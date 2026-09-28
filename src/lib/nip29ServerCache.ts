import { readFolded } from "@/lib/foldedCache";

import type { GroupRef } from "@/lib/nip29";
import type { NostrRumor } from "@/lib/nostrRumor";

/**
 * Offline cache of the user's kind 10009 list (decrypted list + source event).
 * Lets a cold boot paint the rail without a relay round-trip and NIP-44 decrypt,
 * and lets `useUpdateUserGroupList` refuse to build on a failed read. React-free
 * so `NostrProvider` (below the hook's context) can read it.
 */
export interface PersistedGroupList {
  event: NostrRumor;
  groups: GroupRef[];
  servers: string[];
}

/** Fold-cache key for a pubkey's 10009 snapshot. */
export function groupListFoldKey(pubkey: string): string {
  return `nip29-grouplist:${pubkey}`;
}

/** Read the cached 10009 snapshot for `pubkey`, or undefined on a miss. */
export function readCachedGroupList(pubkey: string): Promise<PersistedGroupList | undefined> {
  return readFolded<PersistedGroupList>(groupListFoldKey(pubkey));
}
