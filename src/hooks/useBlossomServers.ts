import { useContext, useMemo } from "react";

import { AppContext } from "@/contexts/AppContext";
import { APP_BLOSSOM_SERVERS, lookupBlossomServers } from "@/lib/blossom";

/**
 * The viewer's Blossom servers to find blobs on, stable across renders. Reads
 * the context directly (app defaults without a provider) since it sits under
 * every avatar. Its own module to avoid a cycle between `useBlossomCandidates`
 * and `useMediaPolicy`.
 */
export function useBlossomServers(): string[] {
  const blossomServerMetadata = useContext(AppContext)?.config.blossomServerMetadata;
  return useMemo(
    () => blossomServerMetadata ? lookupBlossomServers(blossomServerMetadata) : [...APP_BLOSSOM_SERVERS],
    [blossomServerMetadata],
  );
}
