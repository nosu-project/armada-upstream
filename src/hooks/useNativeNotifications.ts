import { useNostrLogin } from "@nostrify/react/login";
import { bytesToHex } from "@noble/hashes/utils.js";
import { nip19 } from "nostr-tools";
import { useCallback, useEffect, useMemo, useState, useSyncExternalStore } from "react";
import { useQuery } from "@tanstack/react-query";

import { useCurrentUser } from "@/hooks/useCurrentUser";
import { useAppContext } from "@/hooks/useAppContext";
import { useKnownDmPeers } from "@/hooks/useKnownDmPeers";
import { useMediaPolicyConfig } from "@/hooks/useMediaPolicy";
import { useNotifLevels } from "@/hooks/useNotifLevels";
import { useUserGroupList } from "@/hooks/useUserGroupList";
import {
  savePushPrefs,
  type PushPrefs,
} from "@/lib/pushPrefs";
import {
  useNotificationSettingsReady,
} from "@/lib/notificationSettingsAuthority";
import {
  ArmadaNotification,
  type NativeNotificationHealth,
} from "@/lib/nativeNotifications";
import { SETTINGS_DTAGS } from "@/lib/settingsDocs";
import { useConcordSubsState } from "@/concord/hooks/useConcordSubs";
import { signStreamAuthsChunked } from "@/concord/lib/streamAuth";
import { useDmRelayList } from "@/hooks/useDmRelayList";
import { effectiveDmRelays, selfStateRelays } from "@/contexts/AppContext";
import {
  hasNativeNotificationService,
  isGitAnnouncementDiscoveryRelay,
  normalizeRelayUrl,
} from "@/lib/platform";
import { useWireGitTicketRoots } from "@/hooks/useWireGitTicketRoots";
import type { GitRepositoryWireInput } from "@/wire/spec";
import { useEventStore } from "@/hooks/useEventStore";
import { GIT_REPOSITORY_ANNOUNCEMENT_KIND, parseGitRepositoryAnnouncement } from "@/lib/gitActivity";
import { registerBeforeAccountExit } from "@/lib/beforeAccountExit";
import {
  nativeNotificationConfigAction,
  type NativeNotificationEnablement,
} from "@/lib/nativeNotificationConfig";

/** localStorage key for the native background-notification intent (toggle). */
const NATIVE_INTENT_KEY = "armada:native-notif-intent";

function loadIntent(): boolean {
  try {
    const raw = localStorage.getItem(NATIVE_INTENT_KEY);
    // Opt-out: background notifications are intended-on by default. They only
    // actually start once the OS notification permission is granted (which may
    // need one tap on Android 13+); the intent persists across launches.
    if (raw === null) return true;
    return raw === "true";
  } catch {
    return true;
  }
}

function saveIntent(on: boolean): void {
  try {
    localStorage.setItem(NATIVE_INTENT_KEY, String(on));
  } catch {
    // ignore
  }
}

/** Whether the user still intends background notifications to be on. */
export function nativeNotificationIntent(): boolean {
  return loadIntent();
}

// ── Shared `enabled` state ───────────────────────────────────────────────────
// `useNativeNotifications` is mounted more than once (the headless
// NativeNotifications mount, plus NotificationSettings while that page is
// open). When `enabled` was per-instance useState, each instance ran its own
// auto-enable effect — which is how a user could be asked for the OS
// notification permission twice — and a grant in one instance never reached the
// headless mount that actually configures the service. One module-level store,
// shared by every instance, fixes both.

// `unknown` is load-bearing: a persisted, working native config must survive
// the WebView's first render while the asynchronous permission check runs.
// Treating that window as `false` used to send configure({enabled:false}) and
// erase the only config the headless service could restart from.
let enabledState: NativeNotificationEnablement = "unknown";
const enabledListeners = new Set<() => void>();

function setEnabledShared(next: NativeNotificationEnablement): void {
  if (enabledState === next) return;
  enabledState = next;
  for (const l of enabledListeners) l();
}

function subscribeEnabled(listener: () => void): () => void {
  enabledListeners.add(listener);
  return () => {
    enabledListeners.delete(listener);
  };
}

/**
 * Request the OS notification permission and, on grant, turn background
 * notifications on for every mounted instance.
 *
 * Exported so the post-login setup flow can drive the OS prompt from an
 * explicit "Enable notifications" tap — this hook no longer fires it on launch.
 * Returns whether permission was granted.
 */
export async function enableNativeNotifications(): Promise<boolean> {
  if (!hasNativeNotificationService()) return false;
  const { granted } = await ArmadaNotification.requestPermission();
  if (!granted) {
    setEnabledShared("disabled");
    return false;
  }
  saveIntent(true);
  setEnabledShared("enabled");
  return true;
}

/** Module-level guard so the launch permission check runs once per app, not per hook instance. */
let autoChecked = false;

// Hook instances are deliberately duplicated (the headless controller and the
// Settings screen). Serialize + de-duplicate native writes at module scope so a
// second mount cannot rebuild every relay socket with the same configuration.
let lastRequestedConfig = "";
let configureQueue: Promise<void> = Promise.resolve();
let lastForcedConfig = "";
let lastForcedConfigAt = 0;

function configureNative(
  payload: Parameters<typeof ArmadaNotification.configure>[0],
  force = false,
): Promise<void> {
  const key = JSON.stringify(payload);
  if (key === lastRequestedConfig && !force) return configureQueue;
  if (force) {
    const now = Date.now();
    // Headless + Settings mounts observe the same stopped snapshot. One repair
    // attempt is enough, while later health polls may retry an OEM-refused FGS.
    if (key === lastForcedConfig && now - lastForcedConfigAt < 5_000) {
      return configureQueue;
    }
    lastForcedConfig = key;
    lastForcedConfigAt = now;
  }
  lastRequestedConfig = key;
  configureQueue = configureQueue
    .catch(() => {})
    .then(() => ArmadaNotification.configure(payload))
    .catch((err) => {
      if (lastRequestedConfig === key) lastRequestedConfig = "";
      throw err;
    });
  return configureQueue;
}

/**
 * Awaitable account-exit barrier. It clears the outgoing account's sealed
 * signer, watches and tray entries before logout/account-switch navigation can
 * reload (or fail to reload), while preserving the user's on/off intent for
 * the next account.
 */
export async function disableNativeNotificationsForAccountExit(): Promise<void> {
  if (!hasNativeNotificationService()) return;
  // Close the controller gate synchronously before the async native/gateway
  // exit cohort runs. Otherwise a readiness/health rerender can enqueue the
  // outgoing account's full payload after this disable and resurrect it during
  // the bounded pre-reload window. Do not change the persisted user intent:
  // the hard reload starts the next account at `unknown` and re-checks it.
  setEnabledShared("disabled");
  await configureNative({ enabled: false });
}

// `useNativeNotifications` has a permanent headless mount and a temporary
// Settings mount. Retain one module-wide account-exit subscription so the
// token-keyed registry does not run the same native teardown twice.
let accountExitMounts = 0;
let unregisterAccountExit: (() => void) | undefined;

function retainAccountExitHandler(): () => void {
  accountExitMounts++;
  if (accountExitMounts === 1) {
    unregisterAccountExit = registerBeforeAccountExit(
      disableNativeNotificationsForAccountExit,
    );
  }
  let retained = true;
  return () => {
    if (!retained) return;
    retained = false;
    accountExitMounts--;
    if (accountExitMounts === 0) {
      unregisterAccountExit?.();
      unregisterAccountExit = undefined;
    }
  };
}

export interface UseNativeNotificationsReturn {
  /** Whether we're in the native APK (where this path applies). */
  supported: boolean;
  /** Whether the user has turned background notifications on. */
  enabled: boolean;
  /** Whether an enable/disable op is in flight. */
  busy: boolean;
  /** Current per-type prefs. */
  prefs: PushPrefs;
  /** Android's non-secret permission/channel/service/socket diagnostics. */
  health?: NativeNotificationHealth;
  /** Refresh the diagnostic snapshot immediately. */
  refreshHealth: () => Promise<void>;
  /** Open Android notification settings, optionally focused on one channel. */
  openSettings: (channel?: "messages" | "calls" | "service") => Promise<void>;
  /** Request notification permission, then start the background service. */
  enable: () => Promise<void>;
  /** Stop the background service. */
  disable: () => Promise<void>;
  /** Update per-type prefs (re-configures the running service). */
  setPrefs: (next: PushPrefs) => Promise<void>;
}

/**
 * Native (Android APK) background notifications.
 *
 * Instead of Web Push — which the Android System WebView doesn't support — the
 * APK runs a foreground service holding a persistent Nostr REQ to the relay,
 * firing local notifications instantly. This hook is the JS control surface:
 * it feeds the service the user's pubkey, relay URLs, joined group ids and
 * prefs, and re-configures it whenever any of those change.
 *
 * On web/PWA this hook is inert (`supported === false`); the web-push path
 * (useNostrPush) handles those. It is also inert on iOS, which has no
 * equivalent service yet (and no Web Push in WKWebView) — see
 * {@link hasNativeNotificationService}.
 */
export function useNativeNotifications(): UseNativeNotificationsReturn {
  const supported = hasNativeNotificationService();
  const { user } = useCurrentUser();
  const storedNotificationSettingsReady = useNotificationSettingsReady(user?.pubkey);
  const { config, updateConfig } = useAppContext();
  // When cross-device settings sync is deliberately disabled, this device's
  // complete per-account AppConfig is the selected policy source. Keep that
  // authority session-local: unlike relay-backed proof it must not survive a
  // later re-enable of automatic settings sync.
  const notificationSettingsReady = storedNotificationSettingsReady
    || config.automaticSettingsSync === false;
  const groupListQuery = useUserGroupList();
  const groupList = groupListQuery.data;
  const {
    knownPeers: dmKnownPeers,
    knownConversationKeys: dmKnownConversations,
    mutedPeers: dmMutedPeers,
    configurationReady: dmPeersConfigReady,
  } = useKnownDmPeers();
  const { channelLevel, concordChannelLevel } = useNotifLevels();

  // Start dormant; the launch check below flips this on when the OS permission
  // is already granted. Shared across every hook instance (see setEnabledShared).
  const enablement = useSyncExternalStore(
    subscribeEnabled,
    () => enabledState,
    () => "unknown" as const,
  );
  const enabled = enablement === "enabled";
  const [busy, setBusy] = useState(false);
  const [health, setHealth] = useState<NativeNotificationHealth>();
  const [permissionCheckAttempt, setPermissionCheckAttempt] = useState(0);
  const prefs = config.pushPrefs;

  useEffect(() => {
    if (!supported) return;
    return retainAccountExitHandler();
  }, [supported]);

  // The relays to hold open. A standalone Armada client has no host, so the
  // source of truth is the user's own kind 10009 list: the relays that host
  // their joined groups, plus any servers they've added. No build-time relay is
  // added here — a hostless device has no host to fall back to.
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
    // Sorted so a relay-list refetch that merely reorders doesn't churn the
    // native config (which would tear down + rebuild every connection).
    return [...set].sort();
  }, [groupList]);

  // The relays the user's OWN documents live on — the same general set the pool
  // routes their replaceables to (NostrProvider's `poolGeneralRelays`): app
  // relays plus their NIP-65 read relays. The service watches the self-state
  // catalogue here and mirrors it into ArmadaDB, so a rail rearranged on
  // another device is already on disk when this one opens.
  //
  // Derived separately from `relayUrls` on purpose: that set comes from the
  // kind-10009 list and is therefore NIP-29 servers only, which a Concord-only
  // user simply doesn't have.
  const selfRelays = useMemo(
    () => selfStateRelays(config, user?.pubkey).sort(),
    [config, user?.pubkey],
  );

  // Joined group ids (the `h` tag values) for the kind-9 filter. Groups at the
  // `nothing` level are omitted entirely (the service never subscribes — no
  // notifications, mentions included). Groups at `mentions` are still watched
  // but flagged in `mentionOnlyGroupIds` so the service suppresses their
  // non-mention messages.
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

  // Each joined group paired with its single host relay. A NIP-29 group lives
  // on exactly one relay, so the native service scopes each relay's kind-9 REQ
  // to just its own groups (see the `groupSubs` field). Deduped + sorted so a
  // group-list refetch that merely reorders doesn't churn the native config.
  const groupSubs = useMemo(() => {
    const seen = new Set<string>();
    const subs: Array<{ relay: string; id: string; mentionOnly: boolean }> = [];
    for (const g of groupList?.groups ?? []) {
      const level = channelLevel(g.relay, g.id);
      if (level === "nothing") continue;
      const relay = normalizeRelayUrl(g.relay);
      if (!relay) continue;
      const key = `${relay}\u0000${g.id}`;
      if (seen.has(key)) continue;
      seen.add(key);
      subs.push({ relay, id: g.id, mentionOnly: level === "mentions" });
    }
    subs.sort((a, b) => a.relay.localeCompare(b.relay) || a.id.localeCompare(b.id));
    return subs;
  }, [groupList, channelLevel]);

  // DM relays: where kind-4 DMs are read from (config.appRelays, or the user's
  // own DM relays if opted in). These are NOT the NIP-29 group relays — DMs
  // live on the general app relays and are addressed by #p, so they get their
  // own connection + filter. UNIONED with the user's PUBLISHED kind-10050
  // inbox, matching the wire (WireSync) and useDm17's inbox scan: NIP-17
  // senders deliver gift wraps to the recipient's published 10050 relays, and
  // on a default login (useOwnDmRelays off) those aren't in effectiveDmRelays
  // — without the union the service would hold its kind-1059 REQ on relays
  // the wraps never reach.
  const {
    relays: publishedDmRelays,
    isReady: dmRelaysReady,
  } = useDmRelayList();
  // `dmsDisabled` collapses this to empty, so the background service holds no
  // kind-1059/kind-4 DM REQ: an account that has opted out of DMs at the
  // network level is not woken by one while the app is dead either.
  const dmRelays = useMemo(() => {
    if (config.dmsDisabled) return [];
    const set = new Set<string>();
    for (const url of [...effectiveDmRelays(config), ...publishedDmRelays]) {
      const n = normalizeRelayUrl(url);
      if (n) set.add(n);
    }
    return [...set].sort();
  }, [config, publishedDmRelays]);

  // `dmFollows` is the historical native payload name. It now carries every
  // established legacy-DM author, including peers recovered from the encrypted
  // conversation index. NIP-17 uses it alongside exact group keys after
  // decrypting a broad inbox wrap.
  const dmFollows = dmKnownPeers;

  // Only explicit DM overrides ride the bridge. Native falls back to the
  // account-global directMessages pref when a canonical conversation key is
  // absent, which preserves the same cascade as useNotifLevels. A group key is
  // the exact sorted participant set (`pk,pk,…`), never one member widened into
  // an unrelated 1:1 policy.
  const dmLevels = useMemo(() => {
    const entries = Object.entries(config.notifLevels)
      .filter(([scope, level]) =>
        scope.startsWith("dm:") &&
        /^(?:[0-9a-f]{64})(?:,[0-9a-f]{64})*$/.test(scope.slice(3)) &&
        (level === "all" || level === "mentions" || level === "nothing"),
      )
      .map(([scope, level]) => [scope.slice(3), level] as const)
      .sort(([a], [b]) => a.localeCompare(b));
    return Object.fromEntries(entries) as Record<string, "all" | "mentions" | "nothing">;
  }, [config.notifLevels]);

  // Where the service may fetch a sender's avatar from — the same policy the
  // WebView applies to the same picture on screen.
  const mediaPolicy = useMediaPolicyConfig();

  // The signer credential shared with the service (Keystore-sealed natively,
  // wiped with the config on disable/logout) so it can open ANY inbox gift
  // wrap and answer NIP-42 AUTH with the app dead. Every login type carries a
  // shareable credential: the nsec's raw key, the NIP-55 signer app's package
  // (its ContentResolver is callable from native code), or the NIP-46 bunker
  // session (client key + bunker pubkey + relays — the identity key stays in
  // the bunker). See NativeSigner.java.
  const { logins } = useNostrLogin();
  const login = logins[0];
  const signerCfg = useMemo(():
    | { type: "key"; sk: string }
    | { type: "amber"; packageName: string }
    | { type: "nip46"; clientSk: string; bunkerPk: string; relays: string[] }
    | undefined => {
    try {
      if (login?.type === "nsec") {
        const decoded = nip19.decode(login.data.nsec);
        if (decoded.type === "nsec") return { type: "key", sk: bytesToHex(decoded.data) };
      }
      if (login?.type === "bunker") {
        const decoded = nip19.decode(login.data.clientNsec);
        if (decoded.type === "nsec") {
          return {
            type: "nip46",
            clientSk: bytesToHex(decoded.data),
            bunkerPk: login.data.bunkerPubkey,
            relays: login.data.relays,
          };
        }
      }
      if (login?.type === "x-android-signer") {
        const { packageName } = login.data as { packageName: string };
        if (packageName) return { type: "amber", packageName };
      }
    } catch {
      // Malformed login data — the service just gets no signer.
    }
    return undefined;
  }, [login]);

  const prefsRecord = useMemo<Record<string, boolean>>(
    () => ({
      mentions: prefs.mentions,
      reactions: prefs.reactions,
      replies: prefs.replies,
      directMessages: prefs.directMessages,
      allGroupMessages: prefs.allGroupMessages,
    }),
    [prefs],
  );

  // Concord channel subscriptions: kind-1059 stream addresses + the
  // conversation keys that open their wraps (see useConcordSubs). Channels at
  // `nothing` are dropped; `mentions` are watched but flagged `mentionOnly` so
  // the service (which CAN decrypt Concord) suppresses non-mention messages.
  const {
    subs: allConcordSubs,
    ready: concordSubsReady,
    left: concordLeftCommunities,
  } = useConcordSubsState();
  const concordSubs = useMemo(
    () =>
      allConcordSubs
        .map((sub) => ({
          sub,
          level: concordChannelLevel("c2", sub.communityId, sub.channelId),
        }))
        .filter(({ level }) => level !== "nothing")
        .map(({ sub, level }) => ({ ...sub, mentionOnly: level === "mentions" })),
    [allConcordSubs, concordChannelLevel],
  );
  // Match the web wire's canonical repository grouping. The channel/community
  // route remains in this local payload and is never copied into relay filters.
  const gitRepositories = useMemo<GitRepositoryWireInput[]>(() => {
    const byAddress = new Map<string, GitRepositoryWireInput>();
    for (const sub of concordSubs) {
      // Git events have no encrypted @-mention signal. A channel set to
      // mentions-only must therefore not receive background Git alerts.
      if (sub.mentionOnly) continue;
      for (const attachment of sub.gitAttachments) {
        let repository = byAddress.get(attachment.address.coordinate);
        if (!repository) {
          repository = { address: attachment.address.coordinate, relays: [], attachments: [] };
          byAddress.set(repository.address, repository);
        }
        repository.relays.push(...attachment.relayHints);
        repository.attachments.push({ channelId: sub.channelId, communityId: sub.communityId, attachment });
      }
    }
    return [...byAddress.values()].map((repository) => ({ ...repository, relays: [...new Set(repository.relays)].sort() }));
  }, [concordSubs]);
  const gitTicketRoots = useWireGitTicketRoots(gitRepositories);
  const eventStore = useEventStore();
  const gitAnnouncements = useQuery({
    queryKey: ["native-notifications", "git-announcements", gitRepositories.map((repository) => repository.address).join("|")],
    enabled: gitRepositories.length > 0,
    staleTime: 30_000,
    queryFn: async () => {
      const store = await eventStore;
      const identifiers = [...new Set(gitRepositories.map((repository) => repository.address.split(":")[2]!))];
      const events = await store.query([{ kinds: [GIT_REPOSITORY_ANNOUNCEMENT_KIND], "#d": identifiers, limit: 1_000 }]);
      return new Map(events.map(parseGitRepositoryAnnouncement).filter((repository): repository is NonNullable<typeof repository> => Boolean(repository)).map((repository) => [repository.address.coordinate, repository]));
    },
  });
  const gitSubs = useMemo(() => gitRepositories.map((repository) => ({
    address: repository.address,
    relays: repository.relays.filter((relay) => !isGitAnnouncementDiscoveryRelay(relay)),
    owner: repository.address.split(":")[1]!,
    // Only a parsed announcement with the exact coordinate contributes trust.
    maintainers: gitAnnouncements.data?.get(repository.address)?.maintainers ?? [],
    attachments: repository.attachments.map(({ channelId, communityId, attachment }) => ({ communityId: communityId ?? "", channelId, attachedAt: attachment.attachedAt, ...(attachment.detachedAt !== undefined ? { detachedAt: attachment.detachedAt } : {}) })),
    ticketRoots: gitTicketRoots.filter((event) => event.tags.some(([name, value]) => name === "a" && value === repository.address)).map((event) => ({ id: event.id, author: event.pubkey, kind: event.kind as 1618 | 1621 })),
  })), [gitRepositories, gitTicketRoots, gitAnnouncements.data]);

  // Send readiness per watch plane. The native bridge replaces ready planes and
  // additively merges partial unready planes for this SAME account, so one
  // offline group-list relay cannot freeze DM roster changes or local
  // notification prefs. A fresh account may bootstrap from useful cached
  // subsets and is enriched plane by
  // plane as each source becomes authoritative.
  useEffect(() => {
    if (!supported) return;

    const loggedOut = !user;
    // A plaintext boot-fold seed is useful for rendering/bootstrap, but it is
    // not authoritative enough to REPLACE native config until the account's
    // kind-10009 relay read has completed for this query.
    const groupListReady = groupList !== undefined && !groupList.decryptFailed &&
      groupList.wireReady === true;
    // Room inclusion/mention flags and Git inclusion are policy-derived, so
    // those planes cannot consume fresh-account defaults before the account's
    // NIP-78 notification document (or proven local last-good) is authoritative.
    const groupPlaneReady = groupListReady && notificationSettingsReady;
    const concordPlaneReady = concordSubsReady && notificationSettingsReady;
    const gitReady = concordPlaneReady &&
      (gitRepositories.length === 0 || gitAnnouncements.data !== undefined);
    const allReady = notificationSettingsReady && groupListReady && dmPeersConfigReady &&
      dmRelaysReady && concordSubsReady && gitReady;
    const nothingToWatch =
      relayUrls.length === 0 &&
      concordSubs.length === 0 &&
      dmRelays.length === 0 &&
      // `selfRelays` counts too: the service's self-state subscription is what
      // keeps the user's own documents — the NIP-78 settings among them — on
      // disk while the app is dead. Leaving it out of this test meant an
      // account with no NIP-29 server, no Concord community and no DM relay
      // never got the service configured at all, so that subscription never
      // ran, however many relays the user had.
      selfRelays.length === 0;

    const action = nativeNotificationConfigAction({
      loggedOut,
      enablement,
      allReady,
      nothingToWatch,
      persistedConfigEnabled: health?.configEnabled,
      policyReady: notificationSettingsReady,
    });

    let payload: Parameters<typeof ArmadaNotification.configure>[0];
    if (action === "disable") {
      payload = { enabled: false };
    } else if (action === "preserve") {
      return;
    } else {
      payload = {
        enabled: true,
        userPubkey: user!.pubkey,
        groupPlaneReady,
        dmRelayPlaneReady: dmRelaysReady,
        dmRosterPlaneReady: dmPeersConfigReady,
        concordPlaneReady,
        gitPlaneReady: gitReady,
        policyPlaneReady: notificationSettingsReady,
        concordLeftCommunities,
        dmRelays,
        dmFollows,
        dmKnownPeers,
        dmKnownConversations,
        dmMutedPeers,
        selfRelays,
        selfDTags: SETTINGS_DTAGS,
        signer: signerCfg,
        ...(notificationSettingsReady ? {
          relayUrls,
          groupIds,
          groupSubs,
          mentionOnlyGroupIds,
          prefs: prefsRecord,
          concordSubs,
          dmLevels,
          dmRequests: prefs.dmRequests,
          gitSubs,
          mediaPolicy,
        } : {}),
      };
    }

    const nativeNeedsRepair = action === "configure" && health !== undefined && (
      !health.configEnabled ||
      !health.serviceRunning ||
      health.loadedConfigRevision !== health.configRevision
    );
    configureNative(payload, nativeNeedsRepair).catch((err) => {
      console.warn("[native-notif] configure failed:", err);
    });
  }, [supported, enablement, user, notificationSettingsReady, relayUrls, groupIds, groupSubs, mentionOnlyGroupIds, prefsRecord, concordSubs, concordSubsReady, concordLeftCommunities, dmRelays, dmRelaysReady, dmFollows, dmKnownPeers, dmKnownConversations, dmLevels, dmMutedPeers, dmPeersConfigReady, prefs.dmRequests, selfRelays, signerCfg, gitSubs, mediaPolicy, groupList, gitRepositories.length, gitAnnouncements.data, health]);

  // Auto-enable on launch (opt-out, like Ditto): if the user hasn't turned it
  // off AND the OS permission is already granted, start the background service
  // silently. This no longer *requests* the permission — an unprompted OS
  // dialog thrown at a user who has just logged in is the worst place to ask,
  // and it raced the other post-login prompts. The ask now lives in the
  // post-login setup flow (LoginSetup), which explains what it's for first and
  // calls enableNativeNotifications() from a real tap; the Settings toggle is
  // the other way in.
  useEffect(() => {
    if (!supported || enablement !== "unknown" || busy || autoChecked) return;
    let cancelled = false;
    let retryTimer: number | undefined;
    autoChecked = true;
    if (!loadIntent()) {
      setEnabledShared("disabled");
      return;
    }
    (async () => {
      try {
        const { granted } = await ArmadaNotification.checkPermission();
        setEnabledShared(granted ? "enabled" : "disabled");
      } catch {
        // An unavailable bridge is not an authoritative "off". Leave the
        // persisted native config intact and retry in this permanent headless
        // mount; relying on another Settings mount left fresh installs dormant
        // for the rest of the session after one transient bridge failure.
        autoChecked = false;
        if (!cancelled) {
          retryTimer = window.setTimeout(() => {
            setPermissionCheckAttempt((attempt) => attempt + 1);
          }, 5_000);
        }
      }
    })();
    return () => {
      cancelled = true;
      if (retryTimer !== undefined) window.clearTimeout(retryTimer);
    };
  }, [supported, enablement, busy, permissionCheckAttempt]);

  const refreshHealth = useCallback(async () => {
    if (!supported) return;
    try {
      setHealth(await ArmadaNotification.getHealth());
    } catch {
      // Older APK paired with a newer WebView: diagnostics are optional and the
      // notification path itself must continue to work.
    }
  }, [supported]);

  useEffect(() => {
    if (!supported) return;
    void refreshHealth();
    const onVisible = () => {
      if (document.visibilityState === "visible") void refreshHealth();
    };
    const timer = window.setInterval(() => {
      if (document.visibilityState === "visible") void refreshHealth();
    }, 15_000);
    document.addEventListener("visibilitychange", onVisible);
    return () => {
      window.clearInterval(timer);
      document.removeEventListener("visibilitychange", onVisible);
    };
  }, [supported, refreshHealth]);

  const openSettings = useCallback(async (
    channel?: "messages" | "calls" | "service",
  ) => {
    if (!supported) return;
    await ArmadaNotification.openNotificationSettings({ channel });
  }, [supported]);

  // The complete set of relays we actually told the native service to watch.
  // Used to validate AUTH challenges before signing: we only sign a kind-22242
  // for a relay we configured, never one the native layer invents.
  const knownRelays = useMemo(() => {
    const set = new Set<string>(relayUrls);
    for (const url of dmRelays) set.add(url);
    for (const sub of concordSubs) {
      for (const url of sub.relays) {
        const n = normalizeRelayUrl(url);
        if (n) set.add(n);
      }
    }
    return set;
  }, [relayUrls, dmRelays, concordSubs]);

  // NIP-42: the service can't sign, so it bridges each relay's AUTH challenge
  // here. We sign a kind-22242 with the user's signer (nsec / bunker /
  // extension — all handled in the WebView) and hand it back. No key ever
  // enters native code.
  const signer = user?.signer;
  useEffect(() => {
    if (!supported || !signer) return;
    let handle: { remove: () => void } | undefined;
    let cancelled = false;
    ArmadaNotification.addListener("authChallenge", async ({ relayUrl, challenge }) => {
      // Only sign for a relay we configured; ignore challenges for anything
      // else so a rogue/unexpected relay URL can't elicit a signature.
      const normalized = normalizeRelayUrl(relayUrl);
      if (!normalized || !knownRelays.has(normalized)) {
        console.warn("[native-notif] ignoring AUTH for unknown relay:", relayUrl);
        return;
      }
      // Concord stream auth first: an auth-gating relay requires every
      // `authors` entry of the service's kind-1059 REQ to be authenticated on
      // that connection. These signatures are local (derived stream secret
      // keys, see streamAuth.ts) and scoped to the keys THIS relay hosts, so
      // they never wait on the user's signer and never sign for communities
      // the relay doesn't carry. Signed in the EC worker pool, a batch at a
      // time, so the burst doesn't block frames.
      try {
        for await (const chunk of signStreamAuthsChunked(challenge, relayUrl)) {
          for (const event of chunk) {
            await ArmadaNotification.submitAuth({ relayUrl, event });
          }
        }
      } catch (err) {
        console.warn("[native-notif] stream AUTH signing failed:", err);
      }
      try {
        const event = await signer.signEvent({
          kind: 22242,
          content: "",
          tags: [
            ["relay", relayUrl],
            ["challenge", challenge],
          ],
          created_at: Math.floor(Date.now() / 1000),
        });
        await ArmadaNotification.submitAuth({ relayUrl, event });
      } catch (err) {
        console.warn("[native-notif] AUTH signing failed:", err);
      }
    }).then((h) => {
      if (cancelled) h.remove();
      else handle = h;
    });
    return () => {
      cancelled = true;
      handle?.remove();
    };
  }, [supported, signer, knownRelays]);

  const enable = useCallback(async () => {
    if (!supported) return;
    setBusy(true);
    try {
      await enableNativeNotifications();
    } finally {
      setBusy(false);
    }
  }, [supported]);

  const disable = useCallback(async () => {
    if (!supported) return;
    setBusy(true);
    try {
      saveIntent(false);
      setEnabledShared("disabled");
      await configureNative({ enabled: false });
    } finally {
      setBusy(false);
    }
  }, [supported]);

  const setPrefs = useCallback(async (next: PushPrefs) => {
    savePushPrefs(next, user?.pubkey);
    updateConfig((current) => ({ ...current, pushPrefs: next }));
  }, [updateConfig, user?.pubkey]);

  return {
    supported,
    enabled,
    busy,
    prefs,
    health,
    refreshHealth,
    openSettings,
    enable,
    disable,
    setPrefs,
  };
}
