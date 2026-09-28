import { useContext, useMemo } from "react";

import { AppContext } from "@/contexts/AppContext";
import { APP_BLOSSOM_SERVERS, getEffectiveBlossomServers } from "@/lib/blossom";

/**
 * The viewer's effective Blossom server list, stable across renders. Reads the
 * context directly (app defaults without a provider) since it sits under every
 * avatar. Its own module to avoid a cycle between `useBlossomCandidates` and
 * `useMediaPolicy`.
 */
export function useBlossomServers(): string[] {
  const config = useContext(AppContext)?.config;
  const appBlossomServers = config?.appBlossomServers ?? APP_BLOSSOM_SERVERS;
  const blossomServerMetadata = config?.blossomServerMetadata;
  const useAppBlossomServers = config?.useAppBlossomServers ?? true;
  return useMemo(
    () =>
      blossomServerMetadata
        ? getEffectiveBlossomServers(appBlossomServers, blossomServerMetadata, useAppBlossomServers)
        : [...appBlossomServers],
    [appBlossomServers, blossomServerMetadata, useAppBlossomServers],
  );
}
