import { useNostr } from "@nostrify/react";
import { useQuery } from "@tanstack/react-query";

import { useEventStore } from "@/hooks/useEventStore";
import { tryNpubEncode } from "@/lib/safeNip19";

import type { NostrRumor } from "@/lib/nostrRumor";

/**
 * NIP-5A root site: a replaceable manifest mapping site paths to Blossom
 * hashes. One per author; `path` tags are the file mappings, so a manifest
 * without any maps no files and serves nothing.
 */
const NSITE_ROOT_KIND = 15128;

/**
 * The public gateway that serves nsites by subdomain (a root site lives at
 * `https://<npub>.<gateway>`). Runtime-configurable like every other endpoint
 * (see platform.ts); the default is the same gateway Ditto links to.
 */
const NSITE_GATEWAY: string = import.meta.env.VITE_NSITE_GATEWAY || "nsite.lol";

export interface NsiteResult {
  /** The gateway URL of the person's root site. */
  url: string;
  /** The site's `title` tag, when it names itself. */
  title?: string;
}

/**
 * Whether a person has published an nsite (NIP-5A root site, kind 15128), and
 * where it is served. Powers the globe button beside "View profile" — absent
 * when they have no site, like Ditto's ProfileNsiteButton.
 */
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

      // A manifest without `path` tags maps no files — nothing to serve.
      if (!event.tags.some(([name]) => name === "path")) return null;

      return {
        url: `https://${npub}.${NSITE_GATEWAY}/`,
        title: event.tags.find(([name]) => name === "title")?.[1],
      };
    },
  });
}
