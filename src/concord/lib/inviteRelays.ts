/**
 * Where a CORD invite reaches a member (CORD-05 §6): their kind-10050 DM relays,
 * else NIP-65 read relays, else the STOCK set every CORD client ships. Send and
 * scan share this resolution so both sides meet. The stock set is fallback-only:
 * a curated private inbox is never also fanned out to public relays.
 */

import { KIND_DM_RELAYS, parseDmRelays } from "@/hooks/useDmRelayList";
import { capRelays } from "@/concord/lib/types";
import { RESCUE_RELAYS } from "@/lib/platform";

import type { NostrEvent, NostrFilter } from "@nostrify/nostrify";

const KIND_RELAY_LIST = 10002;

/** The minimum of a Nostr client this module needs: a pooled query. */
interface NostrQuery {
  query(filters: NostrFilter[], opts?: { signal?: AbortSignal }): Promise<NostrEvent[]>;
}

/**
 * A member's inbox relays (10050, else NIP-65 read). `[]` = confirmed none
 * (use the stock floor); `null` = lookup failed. Distinct on purpose: treating a
 * failure as "no list" would misdeliver invites and leak `#p` REQs to stock relays.
 */
export async function recipientInboxRelays(nostr: NostrQuery, recipient: string): Promise<string[] | null> {
  const events = await nostr
    .query([{ kinds: [KIND_DM_RELAYS, KIND_RELAY_LIST], authors: [recipient], limit: 4 }], {
      signal: AbortSignal.timeout(6000),
    })
    .catch(() => null);
  if (events === null) return null;

  const latestOf = (kind: number) =>
    events.filter((e) => e.kind === kind).sort((a, b) => b.created_at - a.created_at)[0];

  const dm = parseDmRelays(latestOf(KIND_DM_RELAYS));
  if (dm.length > 0) return capRelays(dm);

  // NIP-65 read relays: tags with no marker are read+write.
  const nip65 = latestOf(KIND_RELAY_LIST);
  const reads: string[] = [];
  for (const [name, url, marker] of nip65?.tags ?? []) {
    if (name !== "r" || marker === "write" || !url) continue;
    reads.push(url);
  }
  return capRelays(reads);
}

/**
 * Relays an invite is delivered to / scanned on: the published inbox, else the
 * stock set. Callers must handle a `null` inbox first. Returns a fresh array.
 */
export function inviteDeliveryRelays(inboxRelays: string[]): string[] {
  return inboxRelays.length > 0 ? [...inboxRelays] : [...RESCUE_RELAYS];
}
