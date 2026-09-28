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
 * NIP-29 pins: the relay regenerates kind 39005 from the latest accepted kind 9010, and
 * mutations publish a 9010 with the full replacement list.
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
        // Addressable on the group id; newest wins.
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

  // Optimistic cache update so the banner reflects the change immediately.
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
      // Surface the relay's rejection reason (e.g. "restricted: only admins may pin").
      toast({
        title: "Pin update failed",
        description: relayRejectionMessage(err),
        variant: "destructive",
      });
      queryClient.invalidateQueries({ queryKey });
    },
    // No success invalidation: the 39005 mirror regenerates asynchronously, so an immediate
    // refetch could flicker the change away. The 30s poll converges.
  });

  return {
    pinnedRefs,
    isPinned: (id: string) => pinnedRefs.includes(id),
    isLoading: query.isLoading,
    /** No-op if already pinned. Newest pin is listed first. */
    pin: (id: string) =>
      pinnedRefs.includes(id) ? Promise.resolve() : setPins.mutateAsync([id, ...pinnedRefs]),
    /** Event id or address coordinate; no-op if absent. */
    unpin: (ref: string) =>
      pinnedRefs.includes(ref) ? setPins.mutateAsync(pinnedRefs.filter((p) => p !== ref)) : Promise.resolve(),
    isMutating: setPins.isPending,
  };
}
