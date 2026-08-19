import { useNostr } from "@nostrify/react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";

import { selfStateRelays } from "@/contexts/AppContext";
import { useAppContext } from "@/hooks/useAppContext";
import { useCurrentUser } from "@/hooks/useCurrentUser";
import { useEventStore } from "@/hooks/useEventStore";
import { useNostrPublish } from "@/hooks/useNostrPublish";
import { normalizeBlossomServerUrl, parseBlossomServerList } from "@/lib/blossom";
import {
  newestCanonicalSelfList,
  readStoredCanonicalSelfLists,
} from "@/lib/canonicalSelfList";
import { queryExplicitRelays, queryExplicitRelaysWithStatus } from "@/lib/nip65";

import type { NostrRumor } from "@/lib/nostrRumor";

/**
 * BUD-03 Blossom server list kind. A user publishes the media servers they
 * upload to as `server` tags in this plain replaceable event; other clients
 * (and Armada itself, cross-device) read it to know where their blobs live.
 */
export const KIND_BLOSSOM_SERVERS = 10063;

export interface BlossomServerListQuery {
  event: NostrRumor | null;
  servers: string[];
}

/**
 * Read and write the user's Blossom server list (kind 10063). Mirrors
 * useDmRelayList: Settings edits publish the canonical list; NostrSync pulls
 * newer lists into `config.blossomServerMetadata`.
 */
export function useBlossomServerList() {
  const { nostr } = useNostr();
  const { user } = useCurrentUser();
  const { config } = useAppContext();
  const { mutateAsync: publishEvent } = useNostrPublish();
  const eventStore = useEventStore();
  const queryClient = useQueryClient();

  const queryKey = ["blossom-server-list", user?.pubkey];

  const query = useQuery<BlossomServerListQuery>({
    queryKey,
    enabled: !!user?.pubkey,
    queryFn: async ({ signal }) => {
      const deadline = AbortSignal.any([signal, AbortSignal.timeout(6000)]);
      const [wireEvents, stored] = await Promise.all([
        queryExplicitRelays(
          nostr,
          selfStateRelays(config, user!.pubkey),
          [{ kinds: [KIND_BLOSSOM_SERVERS], authors: [user!.pubkey], limit: 1 }],
          deadline,
        ),
        readStoredCanonicalSelfLists(
          eventStore,
          user!.pubkey,
          [KIND_BLOSSOM_SERVERS],
          deadline,
        ),
      ]);
      const cached = queryClient.getQueryData<BlossomServerListQuery>(queryKey);
      const event = newestCanonicalSelfList(
        [
          ...wireEvents,
          ...stored.events,
          ...(cached?.event ? [cached.event] : []),
        ],
        user!.pubkey,
        KIND_BLOSSOM_SERVERS,
      ) ?? null;
      return { event, servers: event ? parseBlossomServerList(event) : [] };
    },
    staleTime: 60_000,
  });

  const publish = useMutation({
    mutationFn: async (servers: string[]) => {
      if (!user) throw new Error("Not logged in");
      const urls = servers
        .map((url) => normalizeBlossomServerUrl(url))
        .filter((url): url is string => !!url);
      const relays = selfStateRelays(config, user.pubkey);
      const deadline = AbortSignal.timeout(8_000);
      const [response, stored] = await Promise.all([
        queryExplicitRelaysWithStatus(
          nostr,
          relays,
          [{ kinds: [KIND_BLOSSOM_SERVERS], authors: [user.pubkey], limit: 1 }],
          deadline,
        ),
        readStoredCanonicalSelfLists(
          eventStore,
          user.pubkey,
          [KIND_BLOSSOM_SERVERS],
          deadline,
        ),
      ]);
      if (response.answered.length === 0) {
        throw new Error(
          "Could not confirm your current media-server list; no changes were published",
        );
      }
      const cached = queryClient.getQueryData<BlossomServerListQuery>(queryKey);
      const prev = newestCanonicalSelfList(
        [
          ...response.events,
          ...stored.events,
          ...(cached?.event ? [cached.event] : []),
        ],
        user.pubkey,
        KIND_BLOSSOM_SERVERS,
      ) ?? null;
      const tags = [
        ...(prev?.tags.filter(([name]) => name !== "server" && name !== "client") ?? []),
        ...urls.map((url) => ["server", url]),
      ];
      const createdAt = prev
        ? Math.max(Math.floor(Date.now() / 1000), prev.created_at + 1)
        : Math.floor(Date.now() / 1000);

      await publishEvent({
        kind: KIND_BLOSSOM_SERVERS,
        content: prev?.content ?? "",
        tags,
        created_at: createdAt,
        prev: prev ?? undefined,
        relays: response.answered,
        inheritPendingTargets: false,
        onSigned: (event) => {
          queryClient.setQueryData<BlossomServerListQuery>(queryKey, {
            event,
            servers: urls,
          });
        },
      });
      return { servers: urls, createdAt };
    },
  });

  return {
    /** The user's published Blossom servers (empty if they have none). */
    servers: query.data?.servers ?? [],
    event: query.data?.event ?? null,
    isLoading: query.isLoading,
    refetch: query.refetch,
    /** Publish a new kind 10063 Blossom server list. */
    publish: publish.mutateAsync,
  };
}
