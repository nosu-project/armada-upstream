import { useNostr } from "@nostrify/react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";

import { useNostrPublish } from "@/hooks/useNostrPublish";
import { useToast } from "@/hooks/useToast";
import {
  buildGroupPinsTags,
  KIND_GROUP_PINS,
  KIND_UPDATE_PIN_LIST,
  parseGroupPins,
  relayRejectionMessage,
} from "@/lib/nip29";

import type { NostrEvent } from "@nostrify/nostrify";

/**
 * The group's pinned events, per NIP-29: the relay regenerates a kind 39005
 * mirror from the most recent accepted kind 9010 (update-pin-list) moderation
 * event, and mutations publish a new 9010 carrying the full replacement list.
 */
export function usePinnedMessages(relayUrl: string | undefined, groupId: string | undefined) {
  const { nostr } = useNostr();
  const queryClient = useQueryClient();
  const { mutateAsync: publishEvent } = useNostrPublish();
  const { toast } = useToast();

  const queryKey = ["nip29", "pins", relayUrl, groupId];

  const query = useQuery<string[]>({
    queryKey,
    queryFn: async ({ signal }) => {
      const events = await nostr.relay(relayUrl!).query(
        // The mirror is addressable on the group id (`d` tag); newest wins.
        [{ kinds: [KIND_GROUP_PINS], "#d": [groupId!], limit: 5 }],
        { signal: AbortSignal.any([signal, AbortSignal.timeout(8000)]) },
      );
      let newest: NostrEvent | undefined;
      for (const event of events) {
        if (!newest || newest.created_at < event.created_at) newest = event;
      }
      return newest ? parseGroupPins(newest) : [];
    },
    enabled: Boolean(relayUrl && groupId),
    staleTime: 15_000,
    refetchInterval: 30_000,
  });

  const pinnedRefs = query.data ?? [];

  // Publish a new 9010 carrying the full updated pin set. Optimistically
  // updates the cache so the banner/toolbar reflect the change immediately.
  const setPins = useMutation({
    mutationFn: async (nextRefs: string[]) => {
      return publishEvent({
        kind: KIND_UPDATE_PIN_LIST,
        content: "",
        tags: buildGroupPinsTags(groupId!, nextRefs),
        relay: relayUrl,
        onSigned: (event) => {
          queryClient.setQueryData<string[]>(queryKey, parseGroupPins(event));
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
    // No success invalidation: the relay regenerates the 39005 mirror
    // asynchronously after accepting the 9010, so an immediate refetch could
    // read the pre-publish list and flicker the change away. The 30s poll
    // converges instead.
  });

  return {
    pinnedRefs,
    isPinned: (id: string) => pinnedRefs.includes(id),
    isLoading: query.isLoading,
    /** Pin a message (no-op if already pinned). Newest pin is listed first. */
    pin: (id: string) =>
      pinnedRefs.includes(id) ? Promise.resolve() : setPins.mutateAsync([id, ...pinnedRefs]),
    /** Unpin a pin reference (event id or address coordinate); no-op if absent. */
    unpin: (ref: string) =>
      pinnedRefs.includes(ref) ? setPins.mutateAsync(pinnedRefs.filter((p) => p !== ref)) : Promise.resolve(),
    isMutating: setPins.isPending,
  };
}
