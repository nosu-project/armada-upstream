import { KIND_DM_RELAYS, parseDmRelays } from "@/hooks/useDmRelayList";

import type { NostrEvent, NostrFilter } from "@nostrify/nostrify";

interface PoolLike {
  query(filters: NostrFilter[], opts?: { signal?: AbortSignal }): Promise<NostrEvent[]>;
}

/**
 * Relays a creator's new community snapshots: their NIP-17 DM relays (kind
 * 10050), curated for private traffic unlike NIP-65 write relays. [] if none
 * (caller falls back to app relays).
 */
export async function fetchCreatorDmRelays(nostr: PoolLike, pubkey: string): Promise<string[]> {
  const events = await nostr
    .query([{ kinds: [KIND_DM_RELAYS], authors: [pubkey], limit: 2 }], {
      signal: AbortSignal.timeout(6000),
    })
    .catch(() => [] as NostrEvent[]);
  const latest = [...events].sort((a, b) => b.created_at - a.created_at)[0];
  return parseDmRelays(latest);
}
