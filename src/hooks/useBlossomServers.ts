import { useContext, useMemo } from "react";

import { AppContext } from "@/contexts/AppContext";
import { APP_BLOSSOM_SERVERS, getEffectiveBlossomServers } from "@/lib/blossom";

/**
 * The viewer's effective Blossom server list, stable across renders.
 *
 * Reads the context directly rather than through `useAppContext`, which throws
 * without a provider: this sits under every avatar, so it must render wherever
 * an avatar does. With no config in reach the app defaults stand in — the same
 * list a fresh install has.
 *
 * Its own module because both the candidate walk (`useBlossomCandidates`) and
 * the media policy (`useMediaPolicy`) need it, and the walk applies the policy
 * — leaving it in either would make the two import each other.
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
