import { useNostr } from "@nostrify/react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";

import { useNostrPublish } from "@/hooks/useNostrPublish";
import { useToast } from "@/hooks/useToast";
import {
  buildGroupPinsTags,
  KIND_GROUP_PINS,
  parseGroupPins,
  relayRejectionMessage,
} from "@/lib/nip29";

import type { NostrEvent } from "@nostrify/nostrify";

interface PinnedState {
  /** Pinned message ids, in the order they were pinned (newest first). */
  ids: string[];
  /** The kind 39041 event the list was parsed from, if any. */
  event?: NostrEvent;
}

const EMPTY: PinnedState = { ids: [] };

/**
 * The group's pinned messages: a relay-gated, admin-only kind 39041 event
 * (addressable on the group id) carrying one `e` tag per pinned message. The
 * newest such event — regardless of which admin authored it — is authoritative,
 * so any admin can pin/unpin and every member sees the same list.
 */
export function usePinnedMessages(relayUrl: string | undefined, groupId: string | undefined) {
  const { nostr } = useNostr();
  const queryClient = useQueryClient();
  const { mutateAsync: publishEvent } = useNostrPublish();
  const { toast } = useToast();

  const queryKey = ["nip29", "pins", relayUrl, groupId];

  const query = useQuery<PinnedState>({
    queryKey,
    queryFn: async ({ signal }) => {
      const events = await nostr.relay(relayUrl!).query(
        // `#h` is REQUIRED, not just `#d`: relay29's NormalEventQuery only
        // serves filters carrying an `h`/`e`/`a`/`ids` selector. Kind 39041 is
        // our own addressable kind (relay29 has no handler for it), so a
        // `#d`-only query matches none of those branches and the relay returns
        // nothing — pins are stored but never read back. The group `h` tag
        // routes the query straight to the DB (with the `#d` constraint kept).
        [{ kinds: [KIND_GROUP_PINS], "#d": [groupId!], "#h": [groupId!], limit: 20 }],
        { signal: AbortSignal.any([signal, AbortSignal.timeout(8000)]) },
      );
      // Newest event wins (any admin author).
      let newest: NostrEvent | undefined;
      for (const event of events) {
        if (!newest || newest.created_at < event.created_at) newest = event;
      }
      return newest ? { ids: parseGroupPins(newest), event: newest } : EMPTY;
    },
    enabled: Boolean(relayUrl && groupId),
    staleTime: 15_000,
    refetchInterval: 30_000,
  });

  const pinnedIds = query.data?.ids ?? [];

  // Publish a new 39041 carrying the full updated pin set. Optimistically
  // updates the cache so the banner/toolbar reflect the change immediately.
  const setPins = useMutation({
    mutationFn: async (nextIds: string[]) => {
      const prev = query.data?.event;
      return publishEvent({
        kind: KIND_GROUP_PINS,
        content: "",
        tags: buildGroupPinsTags(groupId!, nextIds),
        relay: relayUrl,
        prev,
        onSigned: (event) => {
          queryClient.setQueryData<PinnedState>(queryKey, {
            ids: parseGroupPins(event),
            event,
          });
        },
      });
    },
    onError: (err) => {
      // Surface the relay's rejection reason instead of silently rolling back
      // (e.g. "restricted: only admins may pin").
      toast({
        title: "Pin update failed",
        description: relayRejectionMessage(err),
        variant: "destructive",
      });
      // Roll back to the relay's truth on failure.
      queryClient.invalidateQueries({ queryKey });
    },
    onSettled: () => {
      queryClient.invalidateQueries({ queryKey });
    },
  });

  return {
    pinnedIds,
    isPinned: (id: string) => pinnedIds.includes(id),
    isLoading: query.isLoading,
    /** Pin a message (no-op if already pinned). Newest pin is listed first. */
    pin: (id: string) =>
      pinnedIds.includes(id) ? Promise.resolve() : setPins.mutateAsync([id, ...pinnedIds]),
    /** Unpin a message (no-op if not pinned). */
    unpin: (id: string) =>
      pinnedIds.includes(id) ? setPins.mutateAsync(pinnedIds.filter((p) => p !== id)) : Promise.resolve(),
    isMutating: setPins.isPending,
  };
}
