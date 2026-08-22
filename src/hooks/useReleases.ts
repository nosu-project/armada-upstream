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
 * Every published release of this build's repository, newest first.
 *
 * One query answers both halves of `/downloads` — the latest version's buttons
 * and the older-versions list — because artifacts are carried inline on the
 * release event rather than as separate events to resolve (see
 * `docs/releases.md`). There is no second round-trip and no partial state where
 * a version renders with some of its downloads missing.
 *
 * `authors` is not optional. `#D` alone would accept a release of "armada" from
 * anybody who cares to publish one, on a page whose entire output is
 * executables.
 */
export function useReleases() {
  const { nostr } = useNostr();

  return useQuery<Release[]>({
    queryKey: ["releases", RELEASE_REPO_ID, RELEASE_RELAYS.join(",")],
    enabled: RELEASE_RELAYS.length > 0 && RELEASE_AUTHORS.length > 0,
    staleTime: 5 * 60_000,
    // Unlike the static manifests this replaced, a failure here IS worth
    // retrying: the page has no compiled-in fallback, so a cold pool or a slow
    // relay is the difference between offering downloads and offering none.
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
