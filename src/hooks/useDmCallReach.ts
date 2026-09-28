import { useNostr } from "@nostrify/react";
import { useQuery } from "@tanstack/react-query";

import { useCurrentUser } from "@/hooks/useCurrentUser";
import { useEventStore } from "@/hooks/useEventStore";
import { isDmSynced } from "@/lib/dmSynced";
import { countUnreadDm17Messages } from "@/lib/nip17/dm17Store";

/**
 * Whether a call to `peer` will likely ring for them, from the caller's view:
 * - "likely": they follow us or wrote in our 1:1 (their ring gate admits known peers).
 * - "unlikely": their follow list was READ without us and a completed sync has nothing
 *   from them (see `DmCallProvider`'s ring gate).
 * - "unknown": unresolved/unreadable; don't warn on a failed read.
 */
export type DmCallReach = "likely" | "unlikely" | "unknown";

/** NIP-04 DM. Not imported from `useDirectMessages`: that module is heavy. */
const KIND_DM = 4;

const FOLLOW_READ_TIMEOUT_MS = 5000;

export function useDmCallReach(peer: string | undefined, peerWroteLoaded: boolean): DmCallReach {
  const { nostr } = useNostr();
  const eventStore = useEventStore();
  const { user } = useCurrentUser();
  const self = user?.pubkey;
  const enabled = Boolean(self && peer && peer !== self);
  // Before the first NIP-17 sync, empty means "not synced yet". In the key so that
  // count isn't served afterward.
  const synced = enabled && isDmSynced("nip17", self);

  // `null`: no kind 3 found anywhere — unknown, never "doesn't follow".
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
      // A stored list naming us is enough; otherwise wait for a possibly newer network copy.
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
      if ((await countUnreadDm17Messages(self!, [peer!], -1, { signal })) > 0) return true;
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
