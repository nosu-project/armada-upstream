import { useNostrLogin } from "@nostrify/react/login";
import { bytesToHex } from "@noble/hashes/utils.js";
import { nip19 } from "nostr-tools";
import { useMemo } from "react";

import { useAppContext } from "@/hooks/useAppContext";
import { useCurrentUser } from "@/hooks/useCurrentUser";
import { useDmRelayList } from "@/hooks/useDmRelayList";
import { useKnownDmPeers } from "@/hooks/useKnownDmPeers";
import { useNotifLevels } from "@/hooks/useNotifLevels";
import { useUserGroupList } from "@/hooks/useUserGroupList";
import { effectiveDmRelays } from "@/contexts/AppContext";
import { useConcordSubs } from "@/concord/hooks/useConcordSubs";
import { normalizeRelayUrl } from "@/lib/platform";
import type { PushPrefs } from "@/lib/pushPrefs";
import {
  buildPushSubscriptions,
  type PushSubscriptionSpec,
} from "@/lib/pushSubscriptions";
import type { ConcordSub } from "@/concord/lib/concordNotifications";

/**
 * What a content-blind push controller watches — the same set the Android
 * background service does (`useNativeNotifications`): the user's groups and
 * their per-channel levels, addressed NIP-17 wraps, friends-only legacy DMs,
 * and Concord channels.
 *
 * Shared by every gateway-backed controller (`useNostrPush` for Web Push,
 * `useIosPush` for APNs) so the two cannot drift into watching different
 * things. Only ONE of them is ever mounted — `WebPushNotifications` picks by
 * platform — so this costs nothing to have in both.
 *
 * `specs` is all a controller needs to REGISTER. The remaining fields exist for
 * the web path's sealed service-worker config, which needs the decrypt inputs
 * the worker renders with; they are computed here so the derivations (what
 * counts as a "known" DM peer, which login can hand over a key) live in one
 * place rather than once per platform.
 */
export interface PushWatchSet {
  /** The content-blind subscriptions to register with the gateway. */
  specs: PushSubscriptionSpec[];
  /**
   * Concord channels at their current epoch, above the `nothing` level. Each
   * carries `mentionOnly` (the channel is at the `mentions` level) so the iOS
   * extension can suppress non-mention messages after decrypt — the gateway is
   * content-blind and can't, so it wakes on every message either way.
   */
  concord: Array<ConcordSub & { mentionOnly: boolean }>;
  /** Peers whose DMs are not requests, including authored synced conversations. */
  dmKnownPeers: string[];
  /** Exact pinned/authored NIP-17 rooms, without promoting group members to 1:1 trust. */
  dmKnownConversationKeys: string[];
  /** Peers whose presence suppresses their whole DM conversation. */
  dmMutedPeers: string[];
  /**
   * The account's secret key, for nsec logins ONLY. Bunker (NIP-46) and
   * extension (NIP-07) keys stay off-device, so those logins yield nothing
   * here.
   */
  dmSk?: string;
  /**
   * A bunker login's remote signer, for a background reader that can't open a
   * gift wrap itself but CAN ask the bunker to (`Nip46Client` in the iOS
   * extension). The `clientSk` is the key that addresses the bunker, not the
   * account: strictly weaker than `dmSk`, and revocable at the bunker.
   *
   * The web service worker is deliberately not given this. It would mean a
   * websocket and two bunker round-trips inside a `push` handler that already
   * has an event in hand, on a platform where the page is usually a tab away —
   * the extension has it because iOS gives it no alternative.
   */
  dmBunker?: { clientSk: string; bunkerPubkey: string; relays: string[] };
  /**
   * Whether the established-peer roster is still loading. Callers that persist anything
   * derived from `dmKnownPeers` must wait: writing it mid-load freezes an empty
   * known set on disk, reclassifying every known conversation as a request.
   */
  dmPeersLoading: boolean;
  /**
   * Whether the watch set is still filling in.
   *
   * A caller that PRUNES must wait for this. The sources here load at
   * different speeds — the follow list and the group list come off relays, and
   * `useConcordSubs` only knows a community's channels once its control fold
   * has been read — so an early render produces a REAL but INCOMPLETE spec set.
   * Registering from one is harmless (registration replaces), but pruning from
   * one deletes the gateway records for every community that had not loaded
   * yet, and the user simply stops being notified for them until something
   * happens to re-sync.
   */
  watchSetLoading: boolean;
}

export function usePushWatchSet(prefs: PushPrefs): PushWatchSet {
  const { user } = useCurrentUser();
  const { config } = useAppContext();
  const { data: groupList } = useUserGroupList();
  const {
    knownPeers: dmKnownPeers,
    knownConversationKeys: dmKnownConversationKeys,
    mutedPeers: dmMutedPeers,
    isLoading: dmPeersLoading,
  } = useKnownDmPeers();
  const { logins } = useNostrLogin();
  const { channelLevel, concordChannelLevel } = useNotifLevels();
  const { relays: publishedDmRelays } = useDmRelayList();
  const allConcordSubs = useConcordSubs();

  const relayUrls = useMemo(() => {
    const set = new Set<string>();
    for (const g of groupList?.groups ?? []) {
      const n = normalizeRelayUrl(g.relay);
      if (n) set.add(n);
    }
    for (const url of groupList?.servers ?? []) {
      const n = normalizeRelayUrl(url);
      if (n) set.add(n);
    }
    return [...set].sort();
  }, [groupList]);

  const groupIds = useMemo(
    () =>
      [
        ...new Set(
          (groupList?.groups ?? [])
            .filter((g) => channelLevel(g.relay, g.id) !== "nothing")
            .map((g) => g.id),
        ),
      ].sort(),
    [groupList, channelLevel],
  );

  const mentionOnlyGroupIds = useMemo(
    () =>
      [
        ...new Set(
          (groupList?.groups ?? [])
            .filter((g) => channelLevel(g.relay, g.id) === "mentions")
            .map((g) => g.id),
        ),
      ].sort(),
    [groupList, channelLevel],
  );

  const dmRelays = useMemo(() => {
    const set = new Set<string>();
    for (const url of [...effectiveDmRelays(config), ...publishedDmRelays]) {
      const n = normalizeRelayUrl(url);
      if (n) set.add(n);
    }
    return [...set].sort();
  }, [config, publishedDmRelays]);

  // `dmFollows` is the historical push-spec field name. The author filter now
  // carries the full established-peer roster so a fresh device can receive a
  // legacy DM from an accepted/indexed peer who is no longer followed.
  const dmFollows = dmKnownPeers;

  const dmSk = useMemo(() => {
    const login = logins[0];
    try {
      if (login?.type === "nsec") {
        const decoded = nip19.decode(login.data.nsec);
        if (decoded.type === "nsec") return bytesToHex(decoded.data);
      }
    } catch {
      // Malformed login data — no key, and DM push stays generic.
    }
    return undefined;
  }, [logins]);

  const dmBunker = useMemo(() => {
    const login = logins[0];
    try {
      if (login?.type === "bunker") {
        const decoded = nip19.decode(login.data.clientNsec);
        if (decoded.type !== "nsec") return undefined;
        const relays = login.data.relays.filter((url: string) => Boolean(url));
        if (relays.length === 0) return undefined;
        return {
          clientSk: bytesToHex(decoded.data),
          bunkerPubkey: login.data.bunkerPubkey,
          relays,
        };
      }
    } catch {
      // Malformed login data — no bunker, and DM push stays generic.
    }
    return undefined;
  }, [logins]);

  const concord = useMemo(
    () =>
      allConcordSubs
        .map((sub) => ({
          sub,
          level: concordChannelLevel("c2", sub.communityId, sub.channelId),
        }))
        .filter(({ level }) => level !== "nothing")
        // Carry the mentions-only flag through so the iOS extension (which CAN
        // decrypt Concord) can suppress non-mention messages, mirroring the
        // Android service. The gateway stays content-blind; enforcement is on
        // the device after decrypt.
        .map(({ sub, level }) => ({ ...sub, mentionOnly: level === "mentions" })),
    [allConcordSubs, concordChannelLevel],
  );

  const specs = useMemo(() => {
    if (!user) return [];
    return buildPushSubscriptions({
      pubkey: user.pubkey,
      relayUrls,
      groupIds,
      mentionOnlyGroupIds,
      prefs,
      dmRelays,
      dmFollows,
      concord,
    });
  }, [
    user,
    relayUrls,
    groupIds,
    mentionOnlyGroupIds,
    prefs,
    dmRelays,
    dmFollows,
    concord,
  ]);

  // `groupList === undefined` and a still-loading DM roster both mean the
  // set can still grow. Concord has no loading flag of its own: its subs
  // derive from folds that are themselves read behind these, so the two
  // above are the honest proxy for "not settled yet".
  const watchSetLoading = dmPeersLoading || groupList === undefined;

  return {
    specs,
    concord,
    dmKnownPeers,
    dmKnownConversationKeys,
    dmMutedPeers,
    dmSk,
    dmBunker,
    dmPeersLoading,
    watchSetLoading,
  };
}
