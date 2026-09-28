import { useNostr } from "@nostrify/react";
import { useQuery } from "@tanstack/react-query";

import {
  RELEASE_AUTHORS,
  RELEASE_KIND,
  RELEASE_RELAYS,
  RELEASE_REPO_ID,
  foldReleases,
  parseRelease,
  type Release,
} from "@/lib/releases";

/**
 * Every release of this build's repository, newest first; artifacts ride inline on the release
 * event (`docs/releases.md`). `authors` is mandatory: `#D` alone would accept anyone's executables.
 */
export function useReleases() {
  const { nostr } = useNostr();

  return useQuery<Release[]>({
    queryKey: ["releases", RELEASE_REPO_ID, RELEASE_RELAYS.join(",")],
    enabled: RELEASE_RELAYS.length > 0 && RELEASE_AUTHORS.length > 0,
    staleTime: 5 * 60_000,
    // Retry: there's no compiled-in fallback for downloads.
    retry: 2,
    queryFn: async ({ signal }) => {
      const events = await nostr.group(RELEASE_RELAYS).query(
        [{
          kinds: [RELEASE_KIND],
          authors: RELEASE_AUTHORS,
          "#D": [RELEASE_REPO_ID],
          limit: 200,
        }],
        { signal: AbortSignal.any([signal, AbortSignal.timeout(10_000)]) },
      );
      return foldReleases(events.flatMap((event) => parseRelease(event) ?? []));
    },
  });
}
