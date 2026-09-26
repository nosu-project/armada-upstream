import { useNostr } from "@nostrify/react";
import { useQuery } from "@tanstack/react-query";

import { useCurrentUser } from "@/hooks/useCurrentUser";
import { useEventStore } from "@/hooks/useEventStore";
import { isDmSynced } from "@/lib/dmSynced";
import { countUnreadDm17Messages } from "@/lib/nip17/dm17Store";

/**
 * Whether a call to `peer` can be expected to ring for them, as far as the
 * CALLER can tell.
 *
 *   - `"likely"`: they follow us, or they have written in our 1:1. Either
 *     puts us in their known-peer set, which is what their ring gate admits.
 *   - `"unlikely"`: both answers are in and neither holds — a follow list of
 *     theirs was actually READ and does not name us, and a completed DM sync
 *     holds nothing from them — so their client will likely drop the offer
 *     silently (see `DmCallProvider`'s ring gate).
 *   - `"unknown"`: still resolving, no follow list could be found (an empty
 *     read is indistinguishable from a failed one), or this device has not
 *     finished its first DM sync. Treated as "don't warn": a warning built on
 *     a failed read is a false one.
 *
 * The DM header soft-disables its call button on `"unlikely"`, and still lets
 * the call through. It is an approximation from the caller's side: the
 * callee's set also holds 1:1s they pinned or accepted, which the caller cannot
 * see, and their mute list is private. A peer who writes to us or follows us
 * lifts it, and that is the path the UI offers.
 *
 * `peerWroteLoaded` is whether the loaded thread already shows a message from
 * them; the store reads below cover history outside the loaded page, on both
 * the NIP-17 and the legacy kind-4 plane.
 */
export type DmCallReach = "likely" | "unlikely" | "unknown";

/** NIP-04 DM, as `useDirectMessages` names it (not imported: that module is heavy). */
const KIND_DM = 4;

/** How long the network gets to answer for the peer's kind 3. */
const FOLLOW_READ_TIMEOUT_MS = 5000;

export function useDmCallReach(peer: string | undefined, peerWroteLoaded: boolean): DmCallReach {
  const { nostr } = useNostr();
  const eventStore = useEventStore();
  const { user } = useCurrentUser();
  const self = user?.pubkey;
  const enabled = Boolean(self && peer && peer !== self);
  // Before this device's first NIP-17 sync completes, an empty store means
  // "not synced yet", not "they never wrote". Part of the key, so the count
  // taken during that first sync is not served for the next minute after it.
  const synced = enabled && isDmSynced("nip17", self);

  // `true`/`false`: a kind 3 of theirs was read and does / doesn't name us.
  // `null`: none found anywhere — unknown, never "doesn't follow".
  const follows = useQuery({
    queryKey: ["dm-call-peer-follows", self ?? "", peer ?? ""],
    enabled,
    staleTime: 60_000,
    refetchOnWindowFocus: false,
    retry: false,
    queryFn: async ({ signal }): Promise<boolean | null> => {
      const store = await eventStore;
      const filter = { kinds: [3], authors: [peer!] };
      const [cached] = await store.query([filter]).catch(() => []);
      const namesUs = (ev: { tags: string[][] }) =>
        ev.tags.some((t) => t[0] === "p" && t[1]?.toLowerCase() === self);
      // A stored list naming us is enough; anything else waits for the
      // network, whose copy may be newer than the store's.
      if (cached && namesUs(cached)) return true;
      const [fresh] = await Promise.resolve(
        nostr.query([{ ...filter, limit: 1 }], {
          signal: AbortSignal.any([signal, AbortSignal.timeout(FOLLOW_READ_TIMEOUT_MS)]),
        }),
      ).catch(() => []);
      if (fresh && (!cached || fresh.created_at > cached.created_at)) {
        void store.event(fresh).catch(() => undefined);
        return namesUs(fresh);
      }
      return cached ? namesUs(cached) : null;
    },
  });

  const wrote = useQuery({
    queryKey: ["dm-call-peer-wrote", self ?? "", peer ?? "", synced],
    enabled: synced && !peerWroteLoaded,
    staleTime: 15_000,
    queryFn: async ({ signal }) => {
      // An index-only count of their messages in the 1:1: "unread since 0".
      if ((await countUnreadDm17Messages(self!, [peer!], -1, { signal })) > 0) return true;
      // The legacy kind-4 plane, from the shared store: one row is enough.
      const store = await eventStore;
      const legacy = await store
        .query([{ kinds: [KIND_DM], authors: [peer!], "#p": [self!], limit: 1 }], { signal })
        .catch(() => []);
      return legacy.length > 0;
    },
  });

  if (!enabled) return "unknown";
  if (peerWroteLoaded || wrote.data === true) return "likely";
  if (follows.data === true) return "likely";
  if (!synced || !wrote.isSuccess) return "unknown";
  if (follows.data !== false) return "unknown";
  return "unlikely";
}
