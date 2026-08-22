import { useQuery, useQueryClient } from "@tanstack/react-query";
import { sha256 } from "@noble/hashes/sha2.js";
import { bytesToHex } from "@noble/hashes/utils.js";
import { useEffect, useMemo, useRef } from "react";

import { useCommunityList } from "@/concord/hooks/useCommunityList";
import { readLivePause } from "@/concord/hooks/useControlPlane";
import { canonicalJson, rehydrateCommunity, liveEntries } from "@/concord/lib/communityList";
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
export interface ConcordSubsState {
  /** Last complete derived subscription snapshot (empty is authoritative when ready). */
  subs: ConcordSub[];
  /**
   * True only after both the membership list and the control-fold derivation
   * for that exact list have completed successfully.
   *
   * Callers that REPLACE a persisted/native config or PRUNE remote records
   * must wait for this. `subs: []` while false means "not known yet", not
   * "the account has no Concord channels".
   */
  ready: boolean;
  /**
   * Safe to replace the sealed decrypt config. A complete persisted fold for a
   * non-empty cached membership is trusted last-good data even while a relay
   * is down; only `ready` may authorize gateway pruning.
   */
  configReady: boolean;
  /** The read which prevented this snapshot becoming authoritative, if any. */
  error?: unknown;
}

/**
 * The Concord notification subscriptions together with their completeness.
 *
 * Keep this separate from {@link useConcordSubs}: existing render-only callers
 * can continue consuming the best currently available array, while background
 * controllers opt into the readiness contract before replacing durable state.
 */
export function useConcordSubsState(): ConcordSubsState {
  const communityList = useCommunityList();
  const { data } = communityList;
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
    // Include the complete live membership material. A count-only signature
    // treats "one channel key replaced by another" (or a relay rotation) as
    // the same query and can expose the previous query's success as readiness
    // for a snapshot it never derived.
    () => bytesToHex(sha256(new TextEncoder().encode(canonicalJson(
      [...entries].sort((a, b) => a.community_id.localeCompare(b.community_id)),
    )))),
    [entries],
  );

  // An undecryptable list is public-only and therefore not an authoritative
  // membership snapshot. Do not derive (or later prune from) it.
  // Boot/cache seeds intentionally omit `repairPending`: they paint the rail,
  // but no current relay cohort has confirmed them yet. Only an explicit
  // `false` from syncCommunityList is authority to prune background watches.
  const membershipReady = data !== undefined
    && !data.decryptFailed
    && data.repairPending === false;
  const membershipUsable = data !== undefined && !data.decryptFailed;

  const query = useQuery<{ subs: ConcordSub[]; foldsReady: boolean }>({
    queryKey: ["concord", "notif-subs", listSig],
    enabled: membershipUsable && entries.length > 0,
    staleTime: 30_000,
    // Fold snapshots update out-of-band (when a community's control plane is
    // opened/synced), so re-read them periodically to pick up new channels.
    refetchInterval: 60_000,
    queryFn: async () => {
      const subs: ConcordSub[] = [];
      let foldsReady = true;
      for (const entry of entries) {
        const community = rehydrateCommunity(entry);
        if (!community) {
          foldsReady = false;
          continue;
        }
        const folded = await readControlFold(community.idHex);
        // A cache miss is not an explicitly empty fold. Private channels from
        // the join bundle remain useful additive watches, but public channels
        // exist only in the persisted fold; pruning before it appears would
        // silently remove them.
        if (folded === undefined) foldsReady = false;
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
      return { subs, foldsReady };
    },
  });

  const ready = membershipReady && (entries.length === 0
    || (query.isSuccess && query.data.foldsReady));
  // Do not treat an absent/error-seeded empty membership as an authoritative
  // empty config. A non-empty cached list whose every fold is explicitly
  // persisted is a distinguishable trusted last-good snapshot, though.
  const configReady = ready || (entries.length > 0
    && query.isSuccess
    && query.data.foldsReady);
  const error = communityList.error ?? query.error ?? undefined;
  return {
    subs: query.data?.subs ?? [],
    ready,
    configReady,
    ...(error ? { error } : {}),
  };
}

/**
 * Compatibility view for consumers that do not persist or prune from the
 * result. Background controllers should use {@link useConcordSubsState}.
 */
export function useConcordSubs(): ConcordSub[] {
  return useConcordSubsState().subs;
}
