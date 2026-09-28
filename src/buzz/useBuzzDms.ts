import { useNostr } from "@nostrify/react";
import { useQuery } from "@tanstack/react-query";
import { useCallback, useMemo } from "react";

import { KIND_DM_OPEN, KIND_DM_VISIBILITY } from "@/buzz/kinds";
import { useCurrentUser } from "@/hooks/useCurrentUser";
import { useNostrPublish } from "@/hooks/useNostrPublish";

import type { NostrEvent } from "@nostrify/nostrify";

/**
 * Hidden Buzz DM channels (NIP-DV): the `h` tags of the relay-signed kind-30622
 * snapshot. P-gated: the filter must carry `#p` = the authenticated pubkey.
 */
export function useBuzzHiddenDms(relayUrl: string | undefined): Set<string> {
  const { nostr } = useNostr();
  const { user } = useCurrentUser();

  const query = useQuery<string[]>({
    queryKey: ["buzz", "dm-visibility", relayUrl, user?.pubkey],
    enabled: Boolean(relayUrl && user),
    staleTime: 60_000,
    queryFn: async ({ signal }) => {
      const events = await nostr.relay(relayUrl!).query(
        [{ kinds: [KIND_DM_VISIBILITY], "#p": [user!.pubkey], limit: 1 }],
        { signal: AbortSignal.any([signal, AbortSignal.timeout(8000)]) },
      );
      const newest = events.sort((a, b) => b.created_at - a.created_at)[0];
      if (!newest) return [];
      return newest.tags.filter(([n, v]) => n === "h" && v).map(([, v]) => v);
    },
  });

  return useMemo(() => new Set(query.data ?? []), [query.data]);
}

/**
 * Open a Buzz DM: publish kind 41010 (1–8 `p` tags); the relay creates or reuses
 * a hidden channel, found by its 39000's `p` tags. Returns the channel id.
 */
export function useBuzzOpenDm(relayUrl: string | undefined) {
  const { nostr } = useNostr();
  const { user } = useCurrentUser();
  const { mutateAsync: publish } = useNostrPublish();

  return useCallback(
    async (peer: string): Promise<string> => {
      if (!relayUrl || !user) throw new Error("Sign in to start a conversation.");
      await publish({
        kind: KIND_DM_OPEN,
        content: "",
        tags: [["p", peer]],
        relay: relayUrl,
      });
      // Poll briefly for the relay-emitted 39000.
      const wanted = new Set(peer === user.pubkey ? [user.pubkey] : [user.pubkey, peer]);
      for (let attempt = 0; attempt < 5; attempt++) {
        const metas = await nostr.relay(relayUrl).query(
          [{ kinds: [39000], limit: 200 }],
          { signal: AbortSignal.timeout(6000) },
        );
        const match = metas.find((m: NostrEvent) => {
          if (!m.tags.some(([n]) => n === "hidden")) return false;
          const ps = m.tags.filter(([n]) => n === "p").map(([, v]) => v);
          return ps.length === wanted.size && ps.every((p) => wanted.has(p));
        });
        const id = match?.tags.find(([n]) => n === "d")?.[1];
        if (id) return id;
        await new Promise((r) => setTimeout(r, 400 * (attempt + 1)));
      }
      throw new Error("The conversation was created but couldn't be located yet.");
    },
    [nostr, relayUrl, user, publish],
  );
}
