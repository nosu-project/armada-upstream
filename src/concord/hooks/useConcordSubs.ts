import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect, useMemo, useRef } from "react";

import { useCommunityList } from "@/concord/hooks/useCommunityList";
import { readLivePause } from "@/concord/hooks/useControlPlane";
import { heldChannelKeys, rehydrateCommunity, liveEntries } from "@/concord/lib/communityList";
import { buildConcordSubs, type ConcordSub } from "@/concord/lib/concordNotifications";
import { readControlFold } from "@/concord/lib/control";
import { registerStreamKeys } from "@/concord/lib/streamAuth";
import { onWireScopes } from "@/wire/bus";

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
  const queryClient = useQueryClient();

  // Key the query on membership identity + epoch (what changes the derived
  // streams), not the whole list object, so unrelated list churn is free.
  const entries = useMemo(() => (data ? liveEntries(data.list) : []), [data]);

  // A pause (or its lift) is a control edition delivered on the GLOBAL c2ctl
  // sub for every community, not only the open one. Recompute the sub set when
  // one lands, so a pause on a community the user isn't viewing stops its
  // notifications promptly rather than on the 60s poll. Matched against the
  // live list first: a re-run re-reads every community's fold, which is too
  // much to spend on a `c2ctl:` scope for a community this list doesn't carry.
  const liveIdsRef = useRef<Set<string>>(new Set());
  liveIdsRef.current = useMemo(() => new Set(entries.map((e) => e.community_id.toLowerCase())), [entries]);
  useEffect(
    () =>
      onWireScopes((scopes) => {
        for (const s of scopes) {
          if (s.startsWith("c2ctl:") && liveIdsRef.current.has(s.slice("c2ctl:".length).toLowerCase())) {
            void queryClient.invalidateQueries({ queryKey: ["concord", "notif-subs"] });
            return;
          }
        }
      }),
    [queryClient],
  );
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
        // Freeze: a paused community (CORD-04 §8) drops its chat plane from the
        // background service too, for everyone, staff included — the pause is
        // advisory, so a spammer floods regardless and any listener just eats
        // it. `readLivePause` reads the CURRENT pause rather than `folded`,
        // which for a background community can predate it by hours. The control
        // plane stays subscribed, so the lift still lands and the 60s refetch
        // resumes; an `until` expiry self-resumes with no edition. The window
        // this misses is owed the same catch-up as the wire's, and gets it from
        // the same IOU — WireSync defers the community on the same condition.
        if (await readLivePause(community, Math.floor(Date.now() / 1000))) continue;
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
