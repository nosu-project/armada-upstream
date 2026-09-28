import { useNostr } from "@nostrify/react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect, useMemo } from "react";

import { useBootGateOpen } from "@/lib/bootGate";

import { useCommunityList } from "@/concord/hooks/useCommunityList";
import { activeScopeId } from "@/wire/activation";
import { liveEntries, rehydrateCommunity } from "@/concord/lib/communityList";
import { onStreamKeysAdded } from "@/concord/lib/streamAuth";
import type { Community } from "@/concord/lib/types";
import { syncControlPlane } from "@/lib/controlPlaneSync";
import { logSync } from "@/lib/syncLog";

/** Sync every Concord community's control plane on pageload. The sweep is cursor-gated, so re-runs are cheap. */
function useControlPlaneSync(): void {
  const { nostr } = useNostr();
  const queryClient = useQueryClient();

  const { data: communityListData } = useCommunityList();

  const communities: Community[] = useMemo(() => {
    if (!communityListData) return [];
    const out: Community[] = [];
    for (const entry of liveEntries(communityListData.list)) {
      // Planes live ONLY on the community's own relays. Never add app/platform
      // relays: their instant empty answers can starve the real relays (issue #19).
      const community = rehydrateCommunity(entry);
      if (community) out.push(community);
    }
    return out;
  }, [communityListData]);

  // Changes only when the community set or held epochs (which derive control addresses) change.
  const sig = useMemo(
    () =>
      communities
        .map((c) => `2:${c.idHex}:${c.heldRoots.map((r) => r.epoch).join("-")}`)
        .sort()
        .join(","),
    [communities],
  );

  useQuery({
    queryKey: ["control-plane-sync", sig],
    enabled: communities.length > 0,
    staleTime: 5 * 60_000,
    refetchInterval: 5 * 60_000,
    queryFn: async ({ signal }) => {
      // The active community sweeps first: its control fold gates the timeline on cold load.
      await syncControlPlane(nostr, queryClient, communities, { signal, priorityIdHex: activeScopeId("c2:") });
      return sig;
    },
  });

  // Re-sweep when keys are registered after a sweep ran. `lastRun` starts at
  // mount because planeSync already holds the initial sweep.
  useEffect(() => {
    let timer: ReturnType<typeof setTimeout> | undefined;
    let lastRun = Date.now();
    const MIN_INTERVAL_MS = 60_000;
    /** Late keys auth on the live socket in ~an RTT; a short delay batches a wave. */
    const RE_SWEEP_DELAY_MS = 2_000;
    const unsubscribe = onStreamKeysAdded(() => {
      if (timer !== undefined) return;
      const wait = Math.max(RE_SWEEP_DELAY_MS, lastRun + MIN_INTERVAL_MS - Date.now());
      timer = setTimeout(() => {
        timer = undefined;
        lastRun = Date.now();
        logSync("sweep", "new stream keys registered — re-running the plane sweep");
        queryClient.invalidateQueries({ queryKey: ["control-plane-sync"] });
      }, wait);
    });
    return () => {
      unsubscribe();
      if (timer !== undefined) clearTimeout(timer);
    };
  }, [queryClient]);
}

function ControlPlaneSyncInner() {
  useControlPlaneSync();
  return null;
}

/** Headless control-plane sync. Boot-gated so it doesn't compete with first paint. */
export function ControlPlaneSync() {
  return useBootGateOpen() ? <ControlPlaneSyncInner /> : null;
}
