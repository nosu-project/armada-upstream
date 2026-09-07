import { useNostrLogin } from "@nostrify/react/login";
import { bytesToHex } from "@noble/hashes/utils.js";
import { nip19 } from "nostr-tools";
import { useMemo } from "react";

import { useAppContext } from "@/hooks/useAppContext";
import { useCurrentUser } from "@/hooks/useCurrentUser";
import { useDmRelayList } from "@/hooks/useDmRelayList";
import { useKnownDmPeers } from "@/hooks/useKnownDmPeers";
import { useNotifLevels, type NotifLevel } from "@/hooks/useNotifLevels";
import { useUserGroupList } from "@/hooks/useUserGroupList";
import { effectiveDmRelays } from "@/contexts/AppContext";
import { useConcordSubsState } from "@/concord/hooks/useConcordSubs";
import { normalizeRelayUrl } from "@/lib/platform";
import type { PushPrefs } from "@/lib/pushPrefs";
import {
  buildPushSubscriptions,
  type PushSubscriptionSpec,
} from "@/lib/pushSubscriptions";
import type { ConcordSub } from "@/concord/lib/concordNotifications";
import {
  notificationPolicyIsAuthoritative,
  useNotificationSettingsReady,
} from "@/lib/notificationSettingsAuthority";

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
   * Concord channels at their current epoch. Each carries `mentionOnly` (the
   * channel is at the `mentions` level) so the iOS extension can suppress
   * non-mention messages after decrypt — the gateway is content-blind and
   * can't, so it wakes on every message either way — and `muted` (level
   * `nothing`). A muted channel is deliberately kept in this set, and in the
   * sealed decrypt config, but NOT subscribed (`buildPushSubscriptions` skips
   * it): it exists only so a lingering gateway subscription's wrap can be
   * opened and dropped after decrypt rather than shown as a static wake-up.
   */
  concord: Array<ConcordSub & { mentionOnly: boolean; muted: boolean }>;
  /** Peers whose DMs are not requests, including authored synced conversations. */
  dmKnownPeers: string[];
  /** Exact pinned/authored NIP-17 rooms, without promoting group members to 1:1 trust. */
  dmKnownConversationKeys: string[];
  /** Peers whose presence suppresses their whole DM conversation. */
  dmMutedPeers: string[];
  /**
   * Exact explicit DM notification levels, keyed by the canonical NIP-17
   * conversation key (a sorted participant set). Group-DM keys stay intact;
   * they are never widened into per-participant trust or policy.
   */
  dmLevels: Record<string, NotifLevel>;
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
   * Whether the established-peer roster is still loading for render purposes.
   * Background replacement must use `dmPeersReady`, because a failed wire read
   * can stop loading without making a cache seed authoritative.
   */
  dmPeersLoading: boolean;
  /** Whether follows, mutes, and the encrypted conversation index are authoritative. */
  dmPeersReady: boolean;
  /** Whether Concord membership and every current control-fold derivation settled. */
  concordReady: boolean;
  /** Whether AppConfig's notification slice is an authoritative chosen policy. */
  notificationSettingsReady: boolean;
  /** Whether the DM roster/mute fields in the sealed device config are trusted. */
  dmConfigReady: boolean;
  /** Whether the Concord stream-key fields in the sealed device config are trusted. */
  concordConfigReady: boolean;
  /** Whether NIP-29 records may be removed/replaced from this snapshot. */
  groupPlaneReady: boolean;
  /** Whether DM records may be removed/replaced from this snapshot. */
  dmPlaneReady: boolean;
  /** Whether Concord records may be removed/replaced from this snapshot. */
  concordPlaneReady: boolean;
  /**
   * Whether every field written into the web/iOS decrypt configuration is an
   * authoritative snapshot. NIP-29 membership and the DM relay list affect
   * gateway filters, not that sealed file, so an outage there must not keep
   * otherwise-current decrypt keys/policy stale.
   */
  configReady: boolean;
  /**
   * Whether every input is an authoritative last-good snapshot. A controller
   * may only replace durable/native config or mutate gateway registrations
   * when this is true.
   */
  watchSetReady: boolean;
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

/** Extract only canonical participant-set DM keys from the synced level map. */
export function explicitDmNotificationLevels(
  levels: Record<string, NotifLevel>,
): Record<string, NotifLevel> {
  return Object.fromEntries(
    Object.entries(levels)
      .flatMap(([scope, level]) => {
        if (!scope.startsWith("dm:")) return [];
        const key = scope.slice(3);
        const peers = key.split(",");
        if (peers.length === 0
          || peers.some((peer) => !/^[0-9a-f]{64}$/.test(peer))
          || [...new Set(peers)].sort().join(",") !== key) return [];
        return [[key, level] as const];
      })
      .sort(([a], [b]) => a.localeCompare(b)),
  );
}

/** Never expose specs derived from a fresh account's unauthoritative defaults. */
export function policyAuthorizedPushSpecs(
  ready: boolean,
  specs: PushSubscriptionSpec[],
): PushSubscriptionSpec[] {
  return ready ? specs : [];
}

/**
 * Fail closed per encrypted plane without withholding independent NIP-29
 * watches. The worker receives matching readiness flags, so a partial sealed
 * config cannot render a DM/Concord event from incomplete policy or key data.
 */
export function readyPlanePushSpecs(
  specs: PushSubscriptionSpec[],
  dmReady: boolean,
  concordReady: boolean,
): PushSubscriptionSpec[] {
  return specs.filter((spec) => {
    if (spec.id.startsWith("armada-dm")) return dmReady;
    if (spec.id.startsWith("armada-c2-")) return concordReady;
    return true;
  });
}

export function usePushWatchSet(prefs: PushPrefs): PushWatchSet {
  const { user } = useCurrentUser();
  const { config } = useAppContext();
  const groupListQuery = useUserGroupList();
  const { data: groupList } = groupListQuery;
  const {
    knownPeers: dmKnownPeers,
    knownConversationKeys: dmKnownConversationKeys,
    mutedPeers: dmMutedPeers,
    isLoading: dmPeersLoading,
    authoritativeReady: dmPeersReady,
    configurationReady: dmPeersConfigReady,
  } = useKnownDmPeers();
  const { logins } = useNostrLogin();
  const { channelLevel, concordChannelLevel } = useNotifLevels();
  const {
    relays: publishedDmRelays,
    isReady: dmRelayListReady,
  } = useDmRelayList();
  const {
    subs: allConcordSubs,
    ready: concordReady,
    configReady: concordConfigReady,
  } = useConcordSubsState();
  const durableNotificationSettingsReady = useNotificationSettingsReady(user?.pubkey);
  const notificationSettingsReady = notificationPolicyIsAuthoritative(
    durableNotificationSettingsReady,
    config.automaticSettingsSync,
  );

  const dmLevels = useMemo<Record<string, NotifLevel>>(
    () => explicitDmNotificationLevels(config.notifLevels),
    [config.notifLevels],
  );

  const nip29Groups = useMemo(() => {
    const byRoom = new Map<string, {
      relay: string;
      groupId: string;
      level: "all" | "mentions";
    }>();
    for (const g of groupList?.groups ?? []) {
      const relay = normalizeRelayUrl(g.relay);
      if (!relay || !g.id) continue;
      const level = channelLevel(relay, g.id);
      if (level === "nothing") continue;
      byRoom.set(`${relay}\0${g.id}`, { relay, groupId: g.id, level });
    }
    return [...byRoom.values()].sort((a, b) =>
      a.relay.localeCompare(b.relay) || a.groupId.localeCompare(b.groupId));
  }, [groupList, channelLevel]);

  // `dmsDisabled` collapses this to empty, which drops both DM push specs
  // (each guards on `dmRelays.length > 0`): the content-blind gateway registers
  // no gift-wrap/legacy-DM watch, so no unsolicited DM can wake this device.
  const dmRelays = useMemo(() => {
    if (config.dmsDisabled) return [];
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
        // Carry the mentions-only and muted flags through so the worker / iOS
        // extension (which CAN decrypt Concord) can suppress after decrypt,
        // mirroring the Android service. A `nothing` channel is kept rather
        // than filtered here — `buildPushSubscriptions` drops it from the
        // gateway subscription, but it stays in the sealed config so a wrap
        // from a lingering subscription is opened and dropped, not shown. The
        // gateway stays content-blind; enforcement is on the device.
        .map(({ sub, level }) => ({
          ...sub,
          mentionOnly: level === "mentions",
          muted: level === "nothing",
        })),
    [allConcordSubs, concordChannelLevel],
  );

  const dmConfigReady = dmPeersConfigReady;
  const specs = useMemo(() => {
    if (!user) return [];
    return policyAuthorizedPushSpecs(
      notificationSettingsReady,
      readyPlanePushSpecs(buildPushSubscriptions({
        pubkey: user.pubkey,
        nip29Groups,
        prefs,
        dmRelays,
        dmFollows,
        dmLevels,
        concord,
      }), dmConfigReady, concordConfigReady),
    );
  }, [
    user,
    notificationSettingsReady,
    nip29Groups,
    prefs,
    dmRelays,
    dmFollows,
    dmLevels,
    concord,
    dmConfigReady,
    concordConfigReady,
  ]);

  // Data presence, rather than `isLoading`, distinguishes an authoritative
  // empty result from a query that failed before producing any snapshot.
  // A decrypt-failed NIP-29 list is public-only and must likewise never prune
  // registrations derived from the last complete private list.
  const groupListReady = groupList !== undefined
    && !groupList.decryptFailed
    && groupList.wireReady === true;
  const configReady = notificationSettingsReady
    && dmConfigReady
    && concordConfigReady;
  const groupPlaneReady = notificationSettingsReady && groupListReady;
  const dmPlaneReady = notificationSettingsReady
    && dmConfigReady
    && dmRelayListReady;
  const concordPlaneReady = notificationSettingsReady && concordReady;
  const watchSetReady = groupPlaneReady && dmPlaneReady && concordPlaneReady;
  const watchSetLoading = !watchSetReady;

  return {
    specs,
    concord,
    dmKnownPeers,
    dmKnownConversationKeys,
    dmMutedPeers,
    dmLevels,
    dmSk,
    dmBunker,
    dmPeersLoading,
    dmPeersReady,
    concordReady,
    notificationSettingsReady,
    dmConfigReady,
    concordConfigReady,
    groupPlaneReady,
    dmPlaneReady,
    concordPlaneReady,
    configReady,
    watchSetReady,
    watchSetLoading,
  };
}
