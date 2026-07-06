import { bytesToHex } from "@noble/hashes/utils.js";
import { useNostr } from "@nostrify/react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useMemo } from "react";

import { useConcordList } from "@/concord-v1/hooks/useConcordList";
import { acceptInvite, type CommunityInvite } from "@/concord-v1/lib/invite";
import { capRelays, type Community } from "@/concord-v1/lib/types";
import { useCommunityList2 } from "@/concord-v2/hooks/useCommunityList2";
import { liveEntries, rehydrateCommunity } from "@/concord-v2/lib/communityList";
import type { CommunityV2 } from "@/concord-v2/lib/types";
import { syncControlPlane } from "@/lib/controlPlaneSync";
import { APP_RELAYS } from "@/lib/platform";

/**
 * Sync the control plane of EVERY Concord community (V1 + V2) on pageload.
 *
 * The per-community control hooks only fetch the community you've opened, so
 * rosters/metadata/channels/banlists of every OTHER community stay stale until
 * visited. This runs one batched sweep — two relay filters total, one for all
 * V1 communities and one for all V2 — gated by a single shared cursor, storing
 * results where the per-community hooks read them back (see
 * {@link syncControlPlane}).
 *
 * Driven by a `useQuery` keyed on membership identity, so it runs once the
 * lists load and re-runs only when membership/epochs change — not on every
 * render. `refetchOnWindowFocus`/`staleTime` inherit the app defaults; the
 * sweep is cheap (two filters, shared `since` cursor).
 */
function useControlPlaneSync(): void {
  const { nostr } = useNostr();
  const queryClient = useQueryClient();

  const { data: v1Data } = useConcordList();
  const { data: v2Data } = useCommunityList2();

  // Rehydrate every live membership into a runtime community. Memoized on the
  // decrypted lists so a stable set feeds the query (and its key).
  const v1: Community[] = useMemo(() => {
    if (!v1Data) return [];
    const out: Community[] = [];
    for (const entry of v1Data.list.entries) {
      const invite = entry.current.keys.invite as CommunityInvite | undefined;
      if (!invite) continue;
      try {
        const community = acceptInvite(invite);
        out.push({ ...community, relays: capRelays([...community.relays, ...APP_RELAYS]) });
      } catch {
        // skip unrehydratable entries
      }
    }
    return out;
  }, [v1Data]);

  const v2: CommunityV2[] = useMemo(() => {
    if (!v2Data) return [];
    const out: CommunityV2[] = [];
    for (const entry of liveEntries(v2Data.list)) {
      const community = rehydrateCommunity(entry, APP_RELAYS);
      if (community) out.push(community);
    }
    return out;
  }, [v2Data]);

  // A signature that changes only when the set of communities (or their held
  // epochs, which change the derived control addresses) changes.
  const sig = useMemo(
    () =>
      [
        ...v1.map((c) => `1:${bytesToHex(c.id)}:${c.serverRootEpoch}`),
        ...v2.map((c) => `2:${c.idHex}:${c.heldRoots.map((r) => r.epoch).join("-")}`),
      ]
        .sort()
        .join(","),
    [v1, v2],
  );

  useQuery({
    queryKey: ["control-plane-sync", sig],
    enabled: v1.length > 0 || v2.length > 0,
    // The sweep advances a persisted cursor, so a re-run is cheap; keep it fresh
    // for a while and let a focus/interval-driven refetch catch up.
    staleTime: 5 * 60_000,
    refetchInterval: 5 * 60_000,
    queryFn: async ({ signal }) => {
      await syncControlPlane(nostr, queryClient, v1, v2, { signal });
      return sig;
    },
  });
}

/**
 * Headless mount that syncs every Concord community's control plane on pageload
 * (see {@link useControlPlaneSync}). No UI.
 */
export function ControlPlaneSync() {
  useControlPlaneSync();
  return null;
}
