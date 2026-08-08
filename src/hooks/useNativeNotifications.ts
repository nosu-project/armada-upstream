import { Capacitor } from "@capacitor/core";
import { useNostrLogin } from "@nostrify/react/login";
import { bytesToHex } from "@noble/hashes/utils.js";
import { nip19 } from "nostr-tools";
import { useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore } from "react";
import { useQuery } from "@tanstack/react-query";

import { useCurrentUser } from "@/hooks/useCurrentUser";
import { useAcceptedDms } from "@/hooks/useAcceptedDms";
import { useAppContext } from "@/hooks/useAppContext";
import { useFollowList } from "@/hooks/useFollowList";
import { useNotifLevels } from "@/hooks/useNotifLevels";
import { usePinnedDms } from "@/hooks/usePinnedDms";
import { useUserGroupList } from "@/hooks/useUserGroupList";
import {
  DEFAULT_PUSH_PREFS,
  type PushPrefs,
} from "@/lib/pushPrefs";
import { ArmadaNotification } from "@/lib/nativeNotifications";
import { useConcordSubs } from "@/concord/hooks/useConcordSubs";
import { signStreamAuthsChunked } from "@/concord/lib/streamAuth";
import { useDmRelayList } from "@/hooks/useDmRelayList";
import { effectiveDmRelays, userReadRelays } from "@/contexts/AppContext";
import { isGitAnnouncementDiscoveryRelay, normalizeRelayUrl } from "@/lib/platform";
import { useWireGitTicketRoots } from "@/hooks/useWireGitTicketRoots";
import type { GitRepositoryWireInput } from "@/wire/spec";
import { useEventStore } from "@/hooks/useEventStore";
import { GIT_REPOSITORY_ANNOUNCEMENT_KIND, parseGitRepositoryAnnouncement } from "@/lib/gitActivity";

/** localStorage key for the native background-notification intent (toggle). */
const NATIVE_INTENT_KEY = "armada:native-notif-intent";
/** Shared per-type prefs with the web-push path. */
const PREFS_KEY = "armada:push-prefs";

/** True only inside the Capacitor native runtime (the APK or the iOS app), not web/PWA. */
export function isNativeRuntime(): boolean {
  return Capacitor.isNativePlatform();
}

/**
 * True only where the `ArmadaNotification` background service actually exists.
 *
 * That plugin is Android-only (ArmadaNotificationPlugin.java): the persistent
 * relay service, the native SQLite mirror and the drain bridge all live there.
 * The iOS app is also `isNativeRuntime()`, but every one of those calls rejects
 * with `UNIMPLEMENTED` — so callers that need the service must ask for this,
 * not for "native", or iOS ends up offering notification UI that can't work.
 */
export function hasNativeNotificationService(): boolean {
  return Capacitor.getPlatform() === "android";
}

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

let enabledState = false;
const enabledListeners = new Set<() => void>();

function setEnabledShared(next: boolean): void {
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
  if (!granted) return false;
  saveIntent(true);
  setEnabledShared(true);
  return true;
}

/** Module-level guard so the launch permission check runs once per app, not per hook instance. */
let autoChecked = false;

function loadPrefs(): PushPrefs {
  try {
    const raw = localStorage.getItem(PREFS_KEY);
    if (raw) return { ...DEFAULT_PUSH_PREFS, ...JSON.parse(raw) };
  } catch {
    // ignore
  }
  return { ...DEFAULT_PUSH_PREFS };
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
  const { config } = useAppContext();
  const { data: groupList } = useUserGroupList();
  const { data: followData } = useFollowList();
  const { accepted } = useAcceptedDms();
  const { pinned } = usePinnedDms();
  const { channelLevel, concordChannelLevel } = useNotifLevels();

  // Start dormant; the launch check below flips this on when the OS permission
  // is already granted. Shared across every hook instance (see setEnabledShared).
  const enabled = useSyncExternalStore(subscribeEnabled, () => enabledState, () => false);
  const [busy, setBusy] = useState(false);
  const [prefs, setPrefsState] = useState<PushPrefs>(loadPrefs);

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
  const selfRelays = useMemo(() => {
    const set = new Set<string>();
    if (config.useAppRelays) {
      for (const url of config.appRelays) {
        const n = normalizeRelayUrl(url);
        if (n) set.add(n);
      }
    }
    for (const url of userReadRelays(config)) {
      const n = normalizeRelayUrl(url);
      if (n) set.add(n);
    }
    return [...set].sort();
  }, [config]);

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
    const subs: Array<{ relay: string; id: string }> = [];
    for (const g of groupList?.groups ?? []) {
      if (channelLevel(g.relay, g.id) === "nothing") continue;
      const relay = normalizeRelayUrl(g.relay);
      if (!relay) continue;
      const key = `${relay}\u0000${g.id}`;
      if (seen.has(key)) continue;
      seen.add(key);
      subs.push({ relay, id: g.id });
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
  const { relays: publishedDmRelays } = useDmRelayList();
  const dmRelays = useMemo(() => {
    const set = new Set<string>();
    for (const url of [...effectiveDmRelays(config), ...publishedDmRelays]) {
      const n = normalizeRelayUrl(url);
      if (n) set.add(n);
    }
    return [...set].sort();
  }, [config, publishedDmRelays]);

  // People the user follows (kind 3). The kind-4 DM subscription is scoped to
  // `authors:[...dmFollows]` so the service only fires DM notifications from
  // friends — matching the client's permanent friends-only DM view. Sorted so a
  // follow-list refetch that merely reorders doesn't churn the native config.
  const dmFollows = useMemo(
    () => [...new Set(followData?.pubkeys ?? [])].sort(),
    [followData?.pubkeys],
  );

  // The "known" DM peers — follows ∪ accepted ∪ pinned — mirroring the
  // WebView's `useKnownDmPeers`. A NIP-17 gift wrap can come from anyone (its
  // subscription is the broad `#p` inbox, not author-scoped like kind 4), so
  // the service uses this to tell a friend's DM from a stranger's once it has
  // decrypted the wrap, and gates unknown senders by `dmRequests`. Sorted so a
  // list refetch that merely reorders doesn't churn the native config.
  const dmKnownPeers = useMemo(
    () => [...new Set([...(followData?.pubkeys ?? []), ...accepted, ...pinned])].sort(),
    [followData?.pubkeys, accepted, pinned],
  );

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
  const allConcordSubs = useConcordSubs();
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

  // Push the current config to the native service whenever the relevant inputs
  // change. Three cases:
  //   - turned off / logged out  → tear the service down ({enabled:false}).
  //   - on, but nothing to watch  → do nothing. The lists load async and
  //     transiently read empty; pushing an empty config here would clobber a
  //     working subscription and drop notifications.
  //   - on, with relays/concord   → push the full config.
  const lastConfig = useRef<string>("");
  useEffect(() => {
    if (!supported) return;

    const loggedOut = !user;
    const turnedOff = !enabled;
    const nothingToWatch =
      relayUrls.length === 0 &&
      concordSubs.length === 0 &&
      dmRelays.length === 0;

    let payload: Parameters<typeof ArmadaNotification.configure>[0];
    if (turnedOff || loggedOut) {
      payload = { enabled: false };
    } else if (nothingToWatch) {
      // Still loading the user's groups/communities — keep whatever's running.
      return;
    } else {
      payload = {
        enabled: true,
        userPubkey: user!.pubkey,
        relayUrls,
        groupIds,
        groupSubs,
        mentionOnlyGroupIds,
        prefs: prefsRecord,
        concordSubs,
        dmRelays,
        dmFollows,
        dmKnownPeers,
        dmRequests: prefs.dmRequests,
        selfRelays,
        signer: signerCfg,
        gitSubs,
      };
    }

    // Avoid redundant native round-trips.
    const key = JSON.stringify(payload);
    if (key === lastConfig.current) return;
    lastConfig.current = key;

    ArmadaNotification.configure(payload).catch((err) => {
      console.warn("[native-notif] configure failed:", err);
    });
  }, [supported, enabled, user, relayUrls, groupIds, groupSubs, mentionOnlyGroupIds, prefsRecord, concordSubs, dmRelays, dmFollows, dmKnownPeers, prefs.dmRequests, selfRelays, signerCfg, gitSubs]);

  // Auto-enable on launch (opt-out, like Ditto): if the user hasn't turned it
  // off AND the OS permission is already granted, start the background service
  // silently. This no longer *requests* the permission — an unprompted OS
  // dialog thrown at a user who has just logged in is the worst place to ask,
  // and it raced the other post-login prompts. The ask now lives in the
  // post-login setup flow (LoginSetup), which explains what it's for first and
  // calls enableNativeNotifications() from a real tap; the Settings toggle is
  // the other way in.
  useEffect(() => {
    if (!supported || enabled || busy || autoChecked) return;
    if (!loadIntent()) return;
    autoChecked = true;
    (async () => {
      try {
        const { granted } = await ArmadaNotification.checkPermission();
        if (granted) setEnabledShared(true);
      } catch {
        // Permission check failed — leave dormant.
      }
    })();
  }, [supported, enabled, busy]);

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
      // the relay doesn't carry. Chunked so the burst doesn't block frames.
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
      setEnabledShared(false);
      await ArmadaNotification.configure({ enabled: false });
    } finally {
      setBusy(false);
    }
  }, [supported]);

  const setPrefs = useCallback(async (next: PushPrefs) => {
    setPrefsState(next);
    try {
      localStorage.setItem(PREFS_KEY, JSON.stringify(next));
    } catch {
      // ignore
    }
  }, []);

  return { supported, enabled, busy, prefs, enable, disable, setPrefs };
}
