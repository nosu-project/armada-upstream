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
import { useChannels2 } from "@/concord-v2/hooks/useControlPlane2";
import { useCommunity2, useLiveCommunities2 } from "@/concord-v2/hooks/useCommunityList2";
import { rehydrateCommunity } from "@/concord-v2/lib/communityList";
import { APP_RELAYS } from "@/lib/platform";

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
 */
export function useRegisterAllStreamKeys2(): void {
  const communities = useLiveCommunities2();

  useEffect(() => {
    if (communities.length === 0) return;
    const keys: GroupKey[] = [];
    for (const entry of communities) {
      const community = rehydrateCommunity(entry, APP_RELAYS);
      if (community) keys.push(...communityCoreKeys(community));
    }
    registerStreamKeys(keys);
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
