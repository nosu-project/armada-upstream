import { useNostr } from "@nostrify/react";
import { useQueryClient } from "@tanstack/react-query";
import { useCallback, useState } from "react";

import { useCurrentUser } from "@/hooks/useCurrentUser";
import { useEventStore } from "@/hooks/useEventStore";
import { useNostrPublish } from "@/hooks/useNostrPublish";
import { contactListPubkeys } from "@/lib/contactList";
import { fetchFreshEvent } from "@/lib/fetchFreshEvent";
import { KIND_FOLLOW_LIST } from "@/lib/selfSyncKinds";

import type { FollowListData } from "@/hooks/useFollowList";
import type { NostrRumor } from "@/lib/nostrRumor";

export interface UseFollowActionsReturn {
  /** Whether a follow/unfollow mutation is in progress. */
  isPending: boolean;
  /** Follow a pubkey. Fetches the freshest kind 3 first, then publishes. */
  follow: (pubkey: string) => Promise<void>;
  /** Unfollow a pubkey. Fetches the freshest kind 3 first, then publishes. */
  unfollow: (pubkey: string) => Promise<void>;
}

/**
 * All kind-3 writes run one at a time, process-wide.
 *
 * Every write is a read-modify-write spanning a network read, a signer
 * round-trip and a publish. `isPending` is per-hook-instance, so two different
 * profile cards can each start one — and fired concurrently they both read the
 * SAME pre-edit list, each add only their own pubkey, and the last publish to
 * land overwrites the other. Serializing makes each write observe the previous
 * one's result (mirrors the kind-10000 chain in useMuteList).
 */
let followListWriteChain: Promise<unknown> = Promise.resolve();

function serializeFollowListWrite<T>(write: () => Promise<T>): Promise<T> {
  const run = followListWriteChain.then(write, write);
  // Swallow the result on the chain itself so one failed write neither wedges
  // the queue nor surfaces as an unhandled rejection; the caller still gets it.
  followListWriteChain = run.then(() => undefined, () => undefined);
  return run;
}

/**
 * The created_at for the next version of a replaceable event.
 *
 * Replaceable events are ordered at SECOND granularity, and NIP-01 breaks a
 * created_at tie by lowest event id — so two writes within the same second
 * resolve arbitrarily and the later edit can lose to the earlier one. Following
 * two people in consecutive clicks lands well inside one second, so force
 * strict monotonicity instead of trusting the wall clock.
 */
function nextCreatedAt(prev: NostrRumor | null): number {
  const now = Math.floor(Date.now() / 1000);
  return prev ? Math.max(now, prev.created_at + 1) : now;
}

/**
 * Safe follow / unfollow actions, ported from Ditto's `useFollowActions`.
 *
 * Key safety properties:
 * 1. Fetches the freshest kind 3 event from multiple relays **right before** mutating.
 * 2. Picks the event with the highest `created_at` across all relay responses,
 *    with the locally cached copy as a floor — so a relay miss rebuilds from the
 *    last list we actually saw rather than from nothing.
 * 3. Preserves **all** existing tags (not just `p` tags) so non-follow metadata is not lost.
 * 4. Preserves the `content` field (kind 3 conventionally carries a relay-hint blob there).
 *
 * Reads live in `useFollowList`; this hook never reads the query cache, which
 * can be stale enough to republish a list that has since grown.
 */
export function useFollowActions(): UseFollowActionsReturn {
  const { nostr } = useNostr();
  const { user } = useCurrentUser();
  const { mutateAsync: publishEvent } = useNostrPublish();
  const queryClient = useQueryClient();
  const eventStore = useEventStore();

  const [isPending, setIsPending] = useState(false);

  const mutateFollowList = useCallback(
    async (targetPubkey: string, action: "follow" | "unfollow") => {
      if (!user) throw new Error("Not logged in");
      setIsPending(true);

      try {
        await serializeFollowListWrite(async () => {
          const store = await eventStore;

          // ① Fetch the freshest kind 3 event via pool, falling back to the
          // locally cached copy so a relay miss can't wipe the follow list.
          const prev = await fetchFreshEvent(
            nostr,
            { kinds: [KIND_FOLLOW_LIST], authors: [user.pubkey] },
            { store },
          );

          // ② Separate tags into `p` tags (follow entries) and everything else
          const existingTags = prev?.tags ?? [];
          const pTags = existingTags.filter(([name]) => name === "p");
          const nonPTags = existingTags.filter(([name]) => name !== "p");

          // ③ Compute the new set of `p` tags
          let newPTags: string[][];
          if (action === "follow") {
            // Add only if not already present (dedup)
            const alreadyFollowed = pTags.some(([, pk]) => pk === targetPubkey);
            newPTags = alreadyFollowed ? pTags : [...pTags, ["p", targetPubkey]];
          } else {
            // Remove the target pubkey
            newPTags = pTags.filter(([, pk]) => pk !== targetPubkey);
          }

          // ④ Rebuild the full tag array: non-p tags first, then p tags
          const newTags = [...nonPTags, ...newPTags];

          // ⑤ Preserve the content field (relay hints / petnames in some clients)
          const content = prev?.content ?? "";

          const published = await publishEvent({
            kind: KIND_FOLLOW_LIST,
            content,
            tags: newTags,
            created_at: nextCreatedAt(prev),
            prev: prev ?? undefined,
          });

          // ⑥ Optimistically reflect the new follow list immediately. Relays often
          // haven't indexed the just-published event yet, so an immediate refetch
          // would read stale data and the UI wouldn't update until a later reload.
          // Seed the store + query cache with the event we just published so the
          // cache-fallback path in `fetchContactList` is also correct.
          void store.event(published);
          queryClient.setQueryData<FollowListData>(["follow-list", user.pubkey], {
            event: published,
            pubkeys: contactListPubkeys(published),
            // A signed local winner is trusted last-good config data, but the
            // invalidated all-relay read below must settle before it can grant
            // gateway prune authority.
            wireReady: false,
          });

          // ⑦ Invalidate so the relay copy stays authoritative once it propagates.
          // Safe despite ⑥ because `fetchContactList` returns whichever of the
          // relay and cached copies is newer, and the cache now holds this one.
          queryClient.invalidateQueries({ queryKey: ["follow-list"] });
        });
      } finally {
        setIsPending(false);
      }
    },
    [nostr, user, publishEvent, queryClient, eventStore],
  );

  const follow = useCallback(
    (pubkey: string) => mutateFollowList(pubkey, "follow"),
    [mutateFollowList],
  );

  const unfollow = useCallback(
    (pubkey: string) => mutateFollowList(pubkey, "unfollow"),
    [mutateFollowList],
  );

  return { isPending, follow, unfollow };
}
