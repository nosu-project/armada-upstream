import { useNostr } from "@nostrify/react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";

import { useCurrentUser } from "@/hooks/useCurrentUser";
import { normalizeBlossomServerUrl, parseBlossomServerList } from "@/lib/blossom";

/**
 * BUD-03 Blossom server list kind. A user publishes the media servers they
 * upload to as `server` tags in this plain replaceable event; other clients
 * (and Armada itself, cross-device) read it to know where their blobs live.
 */
export const KIND_BLOSSOM_SERVERS = 10063;

/**
 * Read and write the user's Blossom server list (kind 10063). Mirrors
 * useDmRelayList: Settings edits publish the canonical list; NostrSync pulls
 * newer lists into `config.blossomServerMetadata`.
 */
export function useBlossomServerList() {
  const { nostr } = useNostr();
  const { user } = useCurrentUser();
  const queryClient = useQueryClient();

  const queryKey = ["blossom-server-list", user?.pubkey];

  const query = useQuery<string[]>({
    queryKey,
    enabled: !!user?.pubkey,
    queryFn: async ({ signal }) => {
      const events = await nostr.query(
        [{ kinds: [KIND_BLOSSOM_SERVERS], authors: [user!.pubkey], limit: 1 }],
        { signal: AbortSignal.any([signal, AbortSignal.timeout(6000)]) },
      );
      const event = events.sort((a, b) => b.created_at - a.created_at)[0];
      return event ? parseBlossomServerList(event) : [];
    },
    staleTime: 60_000,
  });

  const publish = useMutation({
    mutationFn: async (servers: string[]) => {
      if (!user) throw new Error("Not logged in");
      const urls = servers
        .map((url) => normalizeBlossomServerUrl(url))
        .filter((url): url is string => !!url);
      const tags = urls.map((url) => ["server", url]);

      const event = await user.signer.signEvent({
        kind: KIND_BLOSSOM_SERVERS,
        content: "",
        tags,
        created_at: Math.floor(Date.now() / 1000),
      });

      queryClient.setQueryData<string[]>(queryKey, urls);
      await nostr.event(event, { signal: AbortSignal.timeout(8000) });
      return { servers: urls, createdAt: event.created_at };
    },
  });

  return {
    /** The user's published Blossom servers (empty if they have none). */
    servers: query.data ?? [],
    isLoading: query.isLoading,
    refetch: query.refetch,
    /** Publish a new kind 10063 Blossom server list. */
    publish: publish.mutateAsync,
  };
}
