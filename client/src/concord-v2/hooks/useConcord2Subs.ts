import { useQuery } from "@tanstack/react-query";
import { useMemo } from "react";

import { controlFoldKey } from "@/concord-v2/hooks/useControlPlane2";
import { useCommunityList2 } from "@/concord-v2/hooks/useCommunityList2";
import { rehydrateCommunity, liveEntries } from "@/concord-v2/lib/communityList";
import { buildConcord2Subs, type Concord2Sub } from "@/concord-v2/lib/concordNotifications2";
import type { FoldedControl } from "@/concord-v2/lib/control";
import type { GroupKey } from "@/concord-v2/lib/derive";
import { registerStreamKeys } from "@/concord-v2/lib/streamAuth";
import { readFolded } from "@/lib/foldedCache";
import { APP_RELAYS } from "@/lib/platform";

/**
 * The Concord V2 native-notification subscriptions for EVERY live community
 * in the user's membership list: per channel, the kind-1059 stream addresses
 * (across held epochs), the conversation keys that open their wraps, and the
 * names/ids for the notification + deep link.
 *
 * Channels are assembled from the persisted control-fold snapshot
 * ({@link controlFoldKey}) — a local IndexedDB read, no relay fan-out — so
 * this stays cheap enough to poll. A community whose fold has never been
 * computed on this device (never opened) contributes only the private
 * channels carried in its join bundle; opening it once fills in the rest.
 *
 * Every derived stream key is also registered with the NIP-42 stream-auth
 * registry, so the WebView can authenticate the native service's kind-1059
 * REQs on auth-gating relays (the service bridges AUTH challenges here).
 */
export function useConcord2Subs(): Concord2Sub[] {
  const { data } = useCommunityList2();

  // Key the query on membership identity + epoch (what changes the derived
  // streams), not the whole list object, so unrelated list churn is free.
  const entries = useMemo(() => (data ? liveEntries(data.list) : []), [data]);
  const listSig = useMemo(
    () =>
      entries
        .map((e) => `${e.community_id}:${e.current.root_epoch}:${(e.current.channels ?? []).length}`)
        .sort()
        .join(","),
    [entries],
  );

  const query = useQuery<Concord2Sub[]>({
    queryKey: ["concord2", "notif-subs", listSig],
    enabled: entries.length > 0,
    staleTime: 30_000,
    // Fold snapshots update out-of-band (when a community's control plane is
    // opened/synced), so re-read them periodically to pick up new channels.
    refetchInterval: 60_000,
    queryFn: async () => {
      const subs: Concord2Sub[] = [];
      const keys: GroupKey[] = [];
      for (const entry of entries) {
        const community = rehydrateCommunity(entry, APP_RELAYS);
        if (!community) continue;
        const folded = await readFolded<FoldedControl>(controlFoldKey(community.idHex));
        const built = buildConcord2Subs(community, folded);
        subs.push(...built.subs);
        keys.push(...built.streamKeys);
      }
      // Register for NIP-42: the native service bridges each relay's AUTH
      // challenge to the WebView, which signs a kind-22242 per registered
      // stream key (see useNativeNotifications) — required by relays that
      // gate kind-1059 REQs behind authenticated `authors`.
      registerStreamKeys(keys);
      return subs;
    },
  });

  return query.data ?? [];
}
