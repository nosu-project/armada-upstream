import { useNostr } from "@nostrify/react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect, useMemo } from "react";

import { useBootGateOpen } from "@/lib/bootGate";

import { useCommunityList2 } from "@/concord-v2/hooks/useCommunityList2";
import { activeScopeId } from "@/wire/activation";
import { liveEntries, rehydrateCommunity } from "@/concord-v2/lib/communityList";
import { onStreamKeysAdded } from "@/concord-v2/lib/streamAuth";
import type { CommunityV2 } from "@/concord-v2/lib/types";
import { syncControlPlane } from "@/lib/controlPlaneSync";
import { logSync } from "@/lib/syncLog";

/**
 * Sync the control plane of every Concord community on pageload.
 * The NIP-42 auth hold lives inside planeSync, where it covers every caller.
 * Driven by a `useQuery` keyed on membership identity; the sweep is
 * cursor-gated, so a re-run is cheap.
 */
function useControlPlaneSync(): void {
  const { nostr } = useNostr();
  const queryClient = useQueryClient();

  const { data: v2Data } = useCommunityList2();

  // Rehydrate every live membership into a runtime community. Memoized on the
  // decrypted list so a stable set feeds the query (and its key).
  const v2: CommunityV2[] = useMemo(() => {
    if (!v2Data) return [];
    const out: CommunityV2[] = [];
    for (const entry of liveEntries(v2Data.list)) {
      // Planes live ONLY on the community's own relays (the bundle/fold's
      // relay set). Never union the deployment's app/platform relays in: they
      // don't store Concord wraps, and their instant empty answers can starve
      // the real relays (issue #19).
      const community = rehydrateCommunity(entry);
      if (community) out.push(community);
    }
    return out;
  }, [v2Data]);

  // A signature that changes only when the set of communities (or their held
  // epochs, which change the derived control addresses) changes.
  const sig = useMemo(
    () =>
      v2
        .map((c) => `2:${c.idHex}:${c.heldRoots.map((r) => r.epoch).join("-")}`)
        .sort()
        .join(","),
    [v2],
  );

  useQuery({
    queryKey: ["control-plane-sync", sig],
    enabled: v2.length > 0,
    // The sweep advances a persisted cursor, so a re-run is cheap; keep it fresh
    // for a while and let a focus/interval-driven refetch catch up.
    staleTime: 5 * 60_000,
    refetchInterval: 5 * 60_000,
    queryFn: async ({ signal }) => {
      // The community the user is currently in (if any) sweeps first — on a
      // cold pageload direct to a community URL, its control fold is the
      // serial gate in front of the timeline.
      await syncControlPlane(nostr, queryClient, v2, { signal, priorityIdHex: activeScopeId("c2:") });
      return sig;
    },
  });

  // Re-sweep backstop: keys registered AFTER a sweep ran (a fold landing for
  // a freshly-synced community) mean new plane addresses to read — sweep
  // again. `lastRun` starts at mount so the first wave doesn't double-sweep —
  // planeSync already holds the initial sweep for it.
  useEffect(() => {
    let timer: ReturnType<typeof setTimeout> | undefined;
    let lastRun = Date.now();
    const MIN_INTERVAL_MS = 60_000;
    /** Late keys auth on the live socket in ~an RTT; a short delay batches a wave. */
    const RE_SWEEP_DELAY_MS = 2_000;
    const unsubscribe = onStreamKeysAdded(() => {
      if (timer !== undefined) return; // a backstop re-sweep is already scheduled
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

/**
 * Headless mount that syncs every Concord community's control plane
 * (see {@link useControlPlaneSync}). No UI. Boot-gated: the sweep is
 * cursor-driven catch-up, so it waits for the first local paint rather than
 * competing with it (see bootGate).
 */
export function ControlPlaneSync() {
  return useBootGateOpen() ? <ControlPlaneSyncInner /> : null;
}
