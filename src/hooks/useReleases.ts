import { useNostr } from "@nostrify/react";
import { useQuery } from "@tanstack/react-query";

import {
  ASSET_KIND,
  RELEASE_APP_ID,
  RELEASE_AUTHORS,
  RELEASE_KIND,
  RELEASE_RELAYS,
  foldReleases,
  parseRelease,
  releaseArtifacts,
  type Release,
  type ReleaseArtifact,
} from "@/lib/releases";

/**
 * Every NIP-82 release of this build's application, newest first, without
 * artifacts (`useReleaseArtifacts`). `authors` is mandatory: `#i` alone would
 * accept anyone's executables.
 */
export function useReleases() {
  const { nostr } = useNostr();

  return useQuery<Release[]>({
    queryKey: ["releases", RELEASE_APP_ID, RELEASE_RELAYS.join(",")],
    enabled: RELEASE_RELAYS.length > 0 && RELEASE_AUTHORS.length > 0,
    staleTime: 5 * 60_000,
    // Retry: there's no compiled-in fallback for downloads.
    retry: 2,
    queryFn: async ({ signal }) => {
      const events = await nostr.group(RELEASE_RELAYS).query(
        [{
          kinds: [RELEASE_KIND],
          authors: RELEASE_AUTHORS,
          "#i": [RELEASE_APP_ID],
          limit: 200,
        }],
        { signal: AbortSignal.any([signal, AbortSignal.timeout(10_000)]) },
      );
      return foldReleases(events.flatMap((event) => parseRelease(event) ?? []));
    },
  });
}

/**
 * One release's kind-3063 assets. Per release rather than for the whole list:
 * relays cap an `ids` query (relay.dreamith.to at ~50), and older releases are
 * only fetched when expanded.
 */
export function useReleaseArtifacts(release: Release | undefined) {
  const { nostr } = useNostr();

  return useQuery<ReleaseArtifact[]>({
    queryKey: ["release-artifacts", release?.id, RELEASE_RELAYS.join(",")],
    enabled: !!release && RELEASE_RELAYS.length > 0,
    staleTime: Infinity,
    retry: 2,
    queryFn: async ({ signal }) => {
      const events = await nostr.group(RELEASE_RELAYS).query(
        [{ kinds: [ASSET_KIND], authors: [release!.pubkey], ids: release!.assetIds }],
        { signal: AbortSignal.any([signal, AbortSignal.timeout(10_000)]) },
      );
      return releaseArtifacts(release!, events);
    },
  });
}
