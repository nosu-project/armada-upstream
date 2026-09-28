import { useNostr } from "@nostrify/react";
import { useQuery } from "@tanstack/react-query";

import { useEventStore } from "@/hooks/useEventStore";
import { tryNpubEncode } from "@/lib/safeNip19";

import type { NostrRumor } from "@/lib/nostrRumor";

/** NIP-5A root site: replaceable manifest of path → Blossom hash; no `path` tags = nothing served. */
const NSITE_ROOT_KIND = 15128;

/** Root sites live at `https://<npub>.<gateway>`. Default matches Ditto. */
const NSITE_GATEWAY: string = import.meta.env.VITE_NSITE_GATEWAY || "nsite.lol";

export interface NsiteResult {
  url: string;
  title?: string;
}

/** The person's nsite (kind 15128), for the globe button beside "View profile". */
export function useNsite(pubkey: string | undefined) {
  const { nostr } = useNostr();
  const eventStore = useEventStore();

  return useQuery<NsiteResult | null>({
    queryKey: ["nsite", pubkey ?? ""],
    enabled: !!pubkey,
    staleTime: 10 * 60_000,
    gcTime: 30 * 60_000,
    refetchOnWindowFocus: false,
    retry: 1,
    queryFn: async ({ signal }) => {
      if (!pubkey) return null;
      const npub = tryNpubEncode(pubkey);
      if (!npub) return null;

      const store = await eventStore;
      const [fromNet] = await nostr.query(
        [{ kinds: [NSITE_ROOT_KIND], authors: [pubkey], limit: 1 }],
        { signal },
      );
      let event: NostrRumor | undefined = fromNet;
      if (fromNet) {
        void store.event(fromNet);
      } else {
        [event] = await store.query([{ kinds: [NSITE_ROOT_KIND], authors: [pubkey] }]);
      }
      if (!event) return null;

      if (!event.tags.some(([name]) => name === "path")) return null;

      return {
        url: `https://${npub}.${NSITE_GATEWAY}/`,
        title: event.tags.find(([name]) => name === "title")?.[1],
      };
    },
  });
}
