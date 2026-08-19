import { readFolded } from "@/lib/foldedCache";

import type { GroupRef } from "@/lib/nip29";
import type { NostrRumor } from "@/lib/nostrRumor";

/**
 * The offline cache of the user's kind 10009 list: the DECRYPTED list plus the
 * event it was folded from.
 *
 * The 10009 event is the single source of truth for the user's NIP-29 servers
 * and joined channels, but reading it costs a relay round-trip plus a NIP-44
 * signer decrypt. This snapshot lets a cold boot paint the rail from plaintext
 * immediately, and lets `useUpdateUserGroupList` refuse a read-modify-write
 * that would build on an empty/failed network read.
 *
 * Kept in a standalone module (no React, no Nostrify context) so consumers
 * that CAN'T use the `useUserGroupList` query — notably `NostrProvider`, which
 * provides the very context that hook depends on — can still read it.
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
