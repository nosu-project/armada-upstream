import { useEffect } from "react";

import {
  baseRekeyGroupKey,
  controlGroupKey,
  dissolvedGroupKey,
  guestbookGroupKey,
  type GroupKey,
} from "@/concord-v2/lib/derive";
import { registerStreamKeys } from "@/concord-v2/lib/streamAuth";
import type { ChannelV2, CommunityV2 } from "@/concord-v2/lib/types";
import { useChannels2, controlFoldKey } from "@/concord-v2/hooks/useControlPlane2";
import { useCommunity2, useLiveCommunities2 } from "@/concord-v2/hooks/useCommunityList2";
import { rehydrateCommunity } from "@/concord-v2/lib/communityList";
import { channelsView } from "@/concord-v2/lib/community";
import type { FoldedControl } from "@/concord-v2/lib/control";
import { readFolded } from "@/lib/foldedCache";

/**
 * The stream keys the client must NIP-42-authenticate as to READ a community's
 * planes on an auth-gating relay (see {@link streamAuth}). These are derivable
 * without the Control fold — enough to unblock the very first control REQ:
 *
 *   - the Control Plane, every held root epoch (channels fold from here);
 *   - the Guestbook Plane, every held epoch (the member list);
 *   - the dissolution tombstone address (id-derived);
 *   - the NEXT base-rekey address (the rekey watcher polls it).
 *
 * Channel stream keys are added separately once the fold names them.
 */
function communityCoreKeys(community: CommunityV2): GroupKey[] {
  const keys: GroupKey[] = [];
  for (const r of community.heldRoots) {
    keys.push(controlGroupKey(r.key, community.id, r.epoch));
    keys.push(guestbookGroupKey(r.key, community.id, r.epoch));
  }
  keys.push(dissolvedGroupKey(community.id));
  keys.push(baseRekeyGroupKey(community.root, community.id, community.rootEpoch + 1n));
  return keys;
}

/** Every per-channel stream key across held epochs (public + held private). */
function channelKeys(channels: ChannelV2[]): GroupKey[] {
  return channels.flatMap((c) => c.streams.map((s) => s.group));
}

/**
 * Register the core stream keys for EVERY live community, so the connection
 * authenticates as their control/guestbook/dissolved/rekey addresses. Mounted
 * once high in the tree (the app shell): the control fold that drives the
 * sidebar can't even read until these are registered.
 *
 * Also registers EVERY community's per-channel stream keys derivable from its
 * persisted control-fold snapshot (a local IndexedDB read, no relay fan-out).
 * This is what lets a channel's kind-1059 backfill pass an auth-gating relay's
 * NIP-42 gate on FIRST open: those relays (ditto-relay's default
 * `AUTH_KINDS=4,1059`) only authenticate a connection's `authors` at the single
 * challenge they issue per socket, and IGNORE a stream AUTH replayed on that
 * spent challenge afterwards. So a channel key registered LATE (only when its
 * community page mounts) never authenticates on the already-challenged socket —
 * both relays then return an empty (auth-filtered) result and the channel reads
 * blank until an app restart re-challenges the fresh socket with every key at
 * once. Registering all channel keys here, up front at the shell, means the
 * initial challenge already covers them. Re-runs on a short poll so folds that
 * land after launch (a community synced for the first time) get their channel
 * keys registered too — a socket opened after that registration will include
 * them in its challenge.
 */
export function useRegisterAllStreamKeys2(): void {
  const communities = useLiveCommunities2();

  useEffect(() => {
    if (communities.length === 0) return;
    let cancelled = false;

    const register = async () => {
      const keys: GroupKey[] = [];
      for (const entry of communities) {
        const community = rehydrateCommunity(entry);
        if (!community) continue;
        keys.push(...communityCoreKeys(community));
        // Per-channel keys from the persisted fold (may be absent on a
        // never-synced community — then only core keys register until it folds).
        try {
          const folded = await readFolded<FoldedControl>(controlFoldKey(community.idHex));
          for (const channel of channelsView(community, folded)) {
            keys.push(...channel.streams.map((s) => s.group));
          }
        } catch {
          // No fold yet; core keys above still cover the control plane so the
          // fold can be fetched, after which a later poll picks up its channels.
        }
      }
      if (!cancelled) registerStreamKeys(keys);
    };

    void register();
    // Folds arrive out-of-band (control-plane sync); re-read periodically so a
    // freshly-synced community's channel keys register without a full reload.
    const timer = setInterval(() => void register(), 20_000);
    return () => {
      cancelled = true;
      clearInterval(timer);
    };
  }, [communities]);
}

/**
 * Register the currently-open community's per-channel stream keys as the fold
 * names them (public channels + any held private ones). Mounted on the
 * community page so reading a channel's timeline passes the relay auth gate.
 */
export function useRegisterChannelStreamKeys2(communityId: string | undefined): void {
  const community = useCommunity2(communityId);
  const channels = useChannels2(community);

  useEffect(() => {
    if (channels.length === 0) return;
    registerStreamKeys(channelKeys(channels));
  }, [channels]);
}
