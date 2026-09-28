import type { NostrFilter, NPool } from "@nostrify/nostrify";

import { isNostrId } from "@/lib/nostrId";

import type { ArmadaEventStore } from "@/contexts/EventStoreContext";
import type { NostrRumor } from "@/lib/nostrRumor";

// Kind 3 (contact list) display reads, ported from Ditto. A newer local copy
// beats an older relay copy (unindexed recent follow), and a relay miss falls
// back to the cache rather than reading as empty. Mutations must use
// `fetchFreshEvent` instead.

const DEFAULT_TIMEOUT = 8000;

/** Latest kind 3 for `pubkey`: relay copy (cached), else local copy, else null. */
export async function fetchContactList(
  nostr: NPool,
  store: ArmadaEventStore,
  pubkey: string,
  opts: { signal?: AbortSignal; timeout?: number } = {},
): Promise<NostrRumor | null> {
  const { signal, timeout = DEFAULT_TIMEOUT } = opts;

  const querySignal = signal
    ? AbortSignal.any([signal, AbortSignal.timeout(timeout)])
    : AbortSignal.timeout(timeout);

  const filter: NostrFilter = { kinds: [3], authors: [pubkey], limit: 1 };

  const [event] = await nostr.query([filter], { signal: querySignal });

  if (event) {
    void store.event(event);

    // A newer local copy (just-published follow the relay hasn't indexed) wins.
    const cached = await readCachedContactList(store, pubkey);
    if (cached && cached.created_at > event.created_at) {
      return cached;
    }
    return event;
  }

  return readCachedContactList(store, pubkey);
}

/** Locally cached kind 3 for `pubkey`, or null. */
export async function readCachedContactList(
  store: ArmadaEventStore,
  pubkey: string,
): Promise<NostrRumor | null> {
  const [cached] = await store.query([{ kinds: [3], authors: [pubkey] }]);
  return cached ?? null;
}

/** Valid `p` pubkeys of a kind 3; non-hex ones would crash nip19 encoders downstream. */
export function contactListPubkeys(event: NostrRumor | null | undefined): string[] {
  if (!event) return [];
  return event.tags
    .filter(([name]) => name === "p")
    .map(([, pk]) => pk)
    .filter(isNostrId);
}
