import { useQuery } from "@tanstack/react-query";
import { useMemo } from "react";

import { useCommunityList } from "@/concord/hooks/useCommunityList";
import { heldChannelKeys, rehydrateCommunity, liveEntries } from "@/concord/lib/communityList";
import { buildConcordSubs, type ConcordSub } from "@/concord/lib/concordNotifications";
import { readControlFold } from "@/concord/lib/control";
import { registerStreamKeys } from "@/concord/lib/streamAuth";

/**
 * The Concord native-notification subscriptions for EVERY live community
 * in the user's membership list: per channel, the kind-1059 stream addresses
 * (across held epochs), the conversation keys that open their wraps, and the
 * names/ids for the notification + deep link.
 *
 * Channels are assembled from the persisted control-fold snapshot
 * ({@link readControlFold}) — a local IndexedDB read, no relay fan-out — so
 * this stays cheap enough to poll. A community whose fold has never been
 * computed on this device (never opened) contributes only the private
 * channels carried in its join bundle; opening it once fills in the rest.
 *
 * Every derived stream key is also registered with the NIP-42 stream-auth
 * registry, so the WebView can authenticate the native service's kind-1059
 * REQs on auth-gating relays (the service bridges AUTH challenges here).
 */
export function useConcordSubs(): ConcordSub[] {
  const { data } = useCommunityList();

  // Key the query on membership identity + epoch (what changes the derived
  // streams), not the whole list object, so unrelated list churn is free.
  const entries = useMemo(() => (data ? liveEntries(data.list) : []), [data]);
  const listSig = useMemo(
    () =>
      entries
        .map((e) => `${e.community_id}:${e.current.root_epoch}:${heldChannelKeys(e.current.channels).length}`)
        .sort()
        .join(","),
    [entries],
  );

  const query = useQuery<ConcordSub[]>({
    queryKey: ["concord", "notif-subs", listSig],
    enabled: entries.length > 0,
    staleTime: 30_000,
    // Fold snapshots update out-of-band (when a community's control plane is
    // opened/synced), so re-read them periodically to pick up new channels.
    refetchInterval: 60_000,
    queryFn: async () => {
      const subs: ConcordSub[] = [];
      for (const entry of entries) {
        const community = rehydrateCommunity(entry);
        if (!community) continue;
        const folded = await readControlFold(community.idHex);
        const built = buildConcordSubs(community, folded);
        subs.push(...built.subs);
        // Register for NIP-42, scoped to the community's relays: the native
        // service bridges each relay's AUTH challenge to the WebView, which
        // signs a kind-22242 per stream key SCOPED TO THAT RELAY (see
        // useNativeNotifications) — required by relays that gate kind-1059
        // REQs behind authenticated `authors`.
        registerStreamKeys(built.streamKeys, community.relays);
      }
      return subs;
    },
  });

  return query.data ?? [];
}
