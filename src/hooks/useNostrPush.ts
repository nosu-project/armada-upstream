import { useNostr } from "@nostrify/react";
import { useNostrLogin } from "@nostrify/react/login";
import { bytesToHex } from "@noble/hashes/utils.js";
import { nip19 } from "nostr-tools";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import { useAcceptedDms } from "@/hooks/useAcceptedDms";
import { useAppContext } from "@/hooks/useAppContext";
import { useCurrentUser } from "@/hooks/useCurrentUser";
import { useDmRelayList } from "@/hooks/useDmRelayList";
import { useFollowList } from "@/hooks/useFollowList";
import { useNotifLevels } from "@/hooks/useNotifLevels";
import { usePinnedDms } from "@/hooks/usePinnedDms";
import { useUserGroupList } from "@/hooks/useUserGroupList";
import { isNativeRuntime } from "@/hooks/useNativeNotifications";
import { clearSwDmConfig, writeSwDmConfig } from "@/lib/swDmConfig";
import {
  DEFAULT_PUSH_PREFS,
  type PushPrefs,
  type UsePushNotificationsReturn,
} from "@/lib/pushPrefs";
import { effectiveDmRelays } from "@/contexts/AppContext";
import { useConcord2Subs } from "@/concord-v2/hooks/useConcord2Subs";
import { NostrPushClient, type PushRelayPool, type PushSigner } from "@/lib/nostrPush";
import {
  buildPushSubscriptions,
  scopePushSubscriptionId,
} from "@/lib/pushSubscriptions";
import {
  NOSTR_PUSH_PUBKEY,
  NOSTR_PUSH_RELAYS,
  normalizeRelayUrl,
  nostrPushConfigured,
} from "@/lib/platform";
import {
  notificationPermissionOf,
  webPushUnavailableReason,
} from "@/lib/webPushSupport";

/**
 * useNostrPush
 *
 * Web Push against a content-blind nostr-push gateway (NIP-PUSH), the
 * replacement for the deprecated armada-relay push endpoint. Unlike the legacy
 * gateway — which is embedded in a relay and sees every stored event — this
 * server only matches the raw filters we register and sends a static wake-up;
 * the service worker fetches and decrypts/renders the referenced event
 * (`sw.js`).
 *
 * This hook mirrors the native Android background service's watch set
 * (`useNativeNotifications`): the same groups, mentions-only levels, addressed
 * NIP-17 wraps, friends-only legacy DMs, and Concord channels — turned
 * into content-blind subscriptions by `buildPushSubscriptions`, then registered
 * with the server.
 * It self-gates: `supported` is false unless a nostr-push server is configured
 * for this build and the signer can NIP-44.
 *
 * Exposes the shared `UsePushNotificationsReturn` interface the settings UI
 * drives.
 */

const PREFS_KEY = "armada:push-prefs";
const INTENT_KEY = "armada:push-intent";
/** Per-domain VAPID key cache (avoids an RPC round-trip on every load). */
const VAPID_KEY = "armada:nostr-push-vapid";
/** The subscription ids we last registered — to prune stale ones. */
const SUBS_KEY = "armada:nostr-push-subs";

function loadIntent(): boolean {
  try {
    const raw = localStorage.getItem(INTENT_KEY);
    return raw === null ? true : raw === "true";
  } catch {
    return true;
  }
}

function saveIntent(on: boolean): void {
  try {
    localStorage.setItem(INTENT_KEY, String(on));
  } catch {
    // ignore
  }
}

function loadPrefs(): PushPrefs {
  try {
    const raw = localStorage.getItem(PREFS_KEY);
    if (raw) return { ...DEFAULT_PUSH_PREFS, ...JSON.parse(raw) };
  } catch {
    // ignore
  }
  return { ...DEFAULT_PUSH_PREFS };
}

function savePrefs(prefs: PushPrefs): void {
  try {
    localStorage.setItem(PREFS_KEY, JSON.stringify(prefs));
  } catch {
    // ignore
  }
}

function loadRegisteredIds(): string[] {
  try {
    const raw = localStorage.getItem(SUBS_KEY);
    if (raw) return JSON.parse(raw);
  } catch {
    // ignore
  }
  return [];
}

function saveRegisteredIds(ids: string[]): void {
  try {
    localStorage.setItem(SUBS_KEY, JSON.stringify(ids));
  } catch {
    // ignore
  }
}

/** base64url (VAPID public key) → ArrayBuffer for applicationServerKey. */
function urlBase64ToBuffer(base64String: string): ArrayBuffer {
  const padding = "=".repeat((4 - (base64String.length % 4)) % 4);
  const base64 = (base64String + padding).replace(/-/g, "+").replace(/_/g, "/");
  const raw = atob(base64);
  const buffer = new ArrayBuffer(raw.length);
  const view = new Uint8Array(buffer);
  for (let i = 0; i < raw.length; i++) view[i] = raw.charCodeAt(i);
  return buffer;
}

/** Whether an existing subscription was made against `vapidKey`. */
function matchesServerKey(sub: PushSubscription, vapidKey: ArrayBuffer): boolean {
  const current = sub.options?.applicationServerKey;
  if (!current) return true;
  const a = new Uint8Array(current);
  const b = new Uint8Array(vapidKey);
  if (a.length !== b.length) return false;
  return a.every((byte, i) => byte === b[i]);
}

function pushDomain(): string {
  return typeof location !== "undefined" ? location.hostname : "";
}

interface PreparedPush {
  registration: ServiceWorkerRegistration;
  key: ArrayBuffer;
  options: PushSubscriptionOptionsInit;
}

async function pushPermission(prepared: PreparedPush): Promise<NotificationPermission> {
  if (typeof Notification !== "undefined") return Notification.permission;
  const existing = await prepared.registration.pushManager.getSubscription();
  if (existing) return "granted";
  if (typeof prepared.registration.pushManager.permissionState === "function") {
    const state = await prepared.registration.pushManager.permissionState(prepared.options);
    return notificationPermissionOf(state);
  }
  return "default";
}

export function useNostrPush(): UsePushNotificationsReturn {
  const { user } = useCurrentUser();
  const { nostr } = useNostr();
  const { config } = useAppContext();
  const { data: groupList } = useUserGroupList();
  const { data: followData } = useFollowList();
  const { accepted } = useAcceptedDms();
  const { pinned } = usePinnedDms();
  const { logins } = useNostrLogin();
  const { channelLevel, concordChannelLevel } = useNotifLevels();
  const { relays: publishedDmRelays } = useDmRelayList();
  const allConcord2Subs = useConcord2Subs();

  const unavailableReason = isNativeRuntime()
    ? "native-runtime" as const
    : webPushUnavailableReason(nostrPushConfigured());
  const supported = unavailableReason === undefined;

  const [permission, setPermission] = useState<NotificationPermission>(
    typeof Notification !== "undefined" ? Notification.permission : "default",
  );
  const [enabled, setEnabled] = useState(false);
  const [busy, setBusy] = useState(false);
  const [ready, setReady] = useState(false);
  const [error, setError] = useState<string>();
  const [prepareNonce, setPrepareNonce] = useState(0);
  const [prefs, setPrefsState] = useState<PushPrefs>(loadPrefs);
  const preparedRef = useRef<PreparedPush | undefined>(undefined);

  // ── Inputs (mirror useNativeNotifications) ─────────────────────────────────

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

  const dmFollows = useMemo(
    () => [...new Set(followData?.pubkeys ?? [])].sort(),
    [followData?.pubkeys],
  );

  // The service worker gates DM push from the wrap the server inlines. It needs
  // the "known" peer set (follows ∪ accepted ∪ pinned, mirroring
  // useKnownDmPeers) and — for nsec logins only — the key to unseal the wrap.
  // Bunker (NIP-46) / extension (NIP-07) keys stay off-device, so those logins
  // pass no key and their DM push stays the generic wake-up.
  const dmKnownPeers = useMemo(
    () => [...new Set([...(followData?.pubkeys ?? []), ...accepted, ...pinned])].sort(),
    [followData?.pubkeys, accepted, pinned],
  );

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

  const concordV2 = useMemo(
    () =>
      allConcord2Subs.filter(
        (sub) => concordChannelLevel("c2", sub.communityId, sub.channelId) !== "nothing",
      ),
    [allConcord2Subs, concordChannelLevel],
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
      concordV2,
    });
  }, [
    user,
    relayUrls,
    groupIds,
    mentionOnlyGroupIds,
    prefs,
    dmRelays,
    dmFollows,
    concordV2,
  ]);

  // Keep the service worker's DM gating config current — policy + known set for
  // every enabled web-push session, plus the decrypt key for nsec logins.
  // Cleared whenever push is off or logged out, so the key never lingers past a
  // session that can use it.
  useEffect(() => {
    if (!supported || !user || !enabled) {
      void clearSwDmConfig();
      return;
    }
    void writeSwDmConfig({
      policy: prefs.dmRequests,
      self: user.pubkey,
      knownPeers: dmKnownPeers,
      ...(dmSk ? { sk: dmSk } : {}),
    });
  }, [supported, user, enabled, prefs.dmRequests, dmKnownPeers, dmSk]);

  // ── Sync ───────────────────────────────────────────────────────────────────

  const client = useMemo(() => {
    if (!supported || !user || !NOSTR_PUSH_PUBKEY) return undefined;
    return new NostrPushClient({
      serverPubkey: NOSTR_PUSH_PUBKEY,
      relays: NOSTR_PUSH_RELAYS,
      signer: user.signer as unknown as PushSigner,
      pool: nostr as unknown as PushRelayPool,
    });
  }, [supported, user, nostr]);

  // Prepare the service worker and public VAPID key before showing an enable
  // action. PushManager.subscribe() has to run directly from the user's tap on
  // iOS; doing this RPC first would consume that transient activation.
  useEffect(() => {
    if (!supported || !client || !user) {
      preparedRef.current = undefined;
      setReady(false);
      return;
    }

    let cancelled = false;
    setReady(false);
    setError(undefined);
    (async () => {
      const domain = pushDomain();
      let vapid = "";
      try {
        vapid = localStorage.getItem(`${VAPID_KEY}:${domain}`) || "";
      } catch {
        // Storage can be unavailable in private browsing; fetch it below.
      }
      if (!vapid) {
        vapid = await client.getVapidKey(domain);
        try {
          localStorage.setItem(`${VAPID_KEY}:${domain}`, vapid);
        } catch {
          // The in-memory prepared value still works for this session.
        }
      }

      const [registration, key] = await Promise.all([
        navigator.serviceWorker.ready,
        Promise.resolve(urlBase64ToBuffer(vapid)),
      ]);
      const options: PushSubscriptionOptionsInit = {
        userVisibleOnly: true,
        applicationServerKey: key,
      };

      // A gateway VAPID rotation makes the old browser subscription unusable.
      // Remove it during preparation so the next user tap can subscribe as its
      // first permission-sensitive operation.
      const existing = await registration.pushManager.getSubscription();
      if (existing && !matchesServerKey(existing, key)) {
        await existing.unsubscribe().catch(() => false);
      }

      const prepared = { registration, key, options };
      const nextPermission = await pushPermission(prepared);
      const current = await registration.pushManager.getSubscription();
      if (cancelled) return;
      preparedRef.current = prepared;
      setPermission(nextPermission);
      setEnabled(Boolean(current && nextPermission === "granted" && loadIntent()));
      setReady(true);
    })().catch((err) => {
      if (cancelled) return;
      console.warn("[nostr-push] preparation failed:", err);
      preparedRef.current = undefined;
      setReady(false);
      setError("Armada couldn't prepare background notifications. Check your connection and try again.");
    });

    return () => {
      cancelled = true;
    };
  }, [supported, client, user, prepareNonce]);

  /** Ensure a current browser subscription, register the specs, prune stale. */
  const sync = useCallback(async (gestureSubscription?: PushSubscription) => {
    const prepared = preparedRef.current;
    if (!client || !user || !prepared) throw new Error("Push not ready");
    const domain = pushDomain();
    const { registration, key, options } = prepared;

    let sub = gestureSubscription ?? await registration.pushManager.getSubscription();
    if (sub && !matchesServerKey(sub, key)) {
      try {
        await sub.unsubscribe();
      } catch {
        // ignore
      }
      sub = null;
    }
    if (!sub) {
      sub = await registration.pushManager.subscribe(options);
    }

    const json = sub.toJSON();
    const pushSubscription = {
      type: "web" as const,
      endpoint: sub.endpoint,
      p256dh_key: json.keys?.p256dh ?? "",
      auth_key: json.keys?.auth ?? "",
    };

    // nostr-push indexes subscription_id globally, not by owner or domain.
    // Scope Armada's readable logical ids so one user/origin cannot occupy the
    // id another user/origin needs.
    const scopedSpecs = specs.map((spec) => ({
      ...spec,
      id: scopePushSubscriptionId(spec.id, user.pubkey, domain),
    }));

    for (const spec of scopedSpecs) {
      await client.registerSubscription({
        subscription_id: spec.id,
        domain,
        filter: spec.filter,
        relays: spec.relays,
        notification: spec.notification,
        push_subscription: pushSubscription,
      });
    }

    // Prune server records we no longer want (left group, muted, logged-out DM).
    const currentIds = new Set(scopedSpecs.map((s) => s.id));
    for (const id of loadRegisteredIds()) {
      if (!currentIds.has(id)) {
        await client.deleteSubscription(id, domain).catch(() => {});
      }
    }
    saveRegisteredIds([...currentIds]);
  }, [client, user, specs]);

  // Auto-(re)sync on every load and whenever the watch set changes: opt-out, so
  // as long as the user intends push, permission is granted, and there is
  // something to watch, keep the server's subscriptions current. Guarded by a
  // signature so an unrelated re-render doesn't re-PUT. Transient failures retry
  // with backoff.
  const syncSig = useMemo(
    () => JSON.stringify({ domain: pushDomain(), pubkey: user?.pubkey, specs }),
    [user?.pubkey, specs],
  );
  const lastSynced = useRef<string | null>(null);
  const retry = useRef(0);
  const [nonce, setNonce] = useState(0);
  useEffect(() => {
    if (!supported || !ready || !client || !user) return;
    if (permission !== "granted") return;
    if (!loadIntent()) return;
    if (specs.length === 0) return; // still loading, or nothing to watch
    if (lastSynced.current === syncSig) return;

    let cancelled = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    (async () => {
      try {
        await sync();
        if (cancelled) return;
        lastSynced.current = syncSig;
        retry.current = 0;
        setError(undefined);
        setEnabled(true);
      } catch (err) {
        if (cancelled) return;
        console.warn("[nostr-push] sync failed:", err);
        if (retry.current < 3) {
          const delay = 10_000 * 2 ** retry.current;
          retry.current += 1;
          timer = setTimeout(() => setNonce((n) => n + 1), delay);
        } else {
          setError("Armada couldn't refresh background notifications. Check your connection and retry.");
        }
      }
    })();
    return () => {
      cancelled = true;
      if (timer) clearTimeout(timer);
    };
  }, [supported, ready, permission, client, user, specs.length, syncSig, sync, nonce]);

  // A rotated browser subscription (SW pushsubscriptionchange → message) must
  // be re-registered with the server.
  useEffect(() => {
    if (!supported || !ready) return;
    const onMessage = (event: MessageEvent) => {
      if (event.data?.type !== "armada-push-changed") return;
      lastSynced.current = null;
      retry.current = 0;
      setNonce((n) => n + 1);
    };
    navigator.serviceWorker.addEventListener("message", onMessage);
    return () => navigator.serviceWorker.removeEventListener("message", onMessage);
  }, [supported, ready]);

  // iOS can rotate or revoke a subscription while Armada is closed. Recheck
  // whenever the app becomes visible/online; granted intent with no current
  // subscription is repaired by the auto-sync effect above.
  useEffect(() => {
    if (!supported || !ready) return;
    let cancelled = false;
    const recheck = async () => {
      if (document.visibilityState !== "visible") return;
      const prepared = preparedRef.current;
      if (!prepared) return;
      try {
        const [nextPermission, existing] = await Promise.all([
          pushPermission(prepared),
          prepared.registration.pushManager.getSubscription(),
        ]);
        if (cancelled) return;
        setPermission(nextPermission);
        setEnabled(Boolean(existing && nextPermission === "granted" && loadIntent()));
        if (!existing && nextPermission === "granted" && loadIntent()) {
          lastSynced.current = null;
          retry.current = 0;
          setNonce((n) => n + 1);
        }
      } catch {
        // Leave the last known state; the explicit retry remains available.
      }
    };
    document.addEventListener("visibilitychange", recheck);
    window.addEventListener("online", recheck);
    return () => {
      cancelled = true;
      document.removeEventListener("visibilitychange", recheck);
      window.removeEventListener("online", recheck);
    };
  }, [supported, ready]);

  // ── Public actions ─────────────────────────────────────────────────────────

  const enable = useCallback(async () => {
    const prepared = preparedRef.current;
    if (!supported || !ready || !user || !prepared) return;
    setBusy(true);
    setError(undefined);

    // Call subscribe synchronously from the toggle's click. Besides creating
    // the endpoint, this is the standards-based permission request; unlike
    // Notification.requestPermission(), it also works in iOS Home-Screen web
    // apps where window.Notification is unexpectedly absent.
    const subscriptionPromise = prepared.registration.pushManager.subscribe(prepared.options);
    try {
      const subscription = await subscriptionPromise;
      setPermission("granted");
      saveIntent(true);
      lastSynced.current = null;
      await sync(subscription);
      lastSynced.current = syncSig;
      setEnabled(true);
    } catch (err) {
      const nextPermission = await pushPermission(prepared).catch(() => permission);
      setPermission(nextPermission);
      if (nextPermission !== "denied") {
        console.warn("[nostr-push] enable failed:", err);
        setError("Armada couldn't enable background notifications. Check your connection and retry.");
      }
    } finally {
      setBusy(false);
    }
  }, [supported, ready, user, sync, syncSig, permission]);

  const disable = useCallback(async () => {
    setBusy(true);
    try {
      saveIntent(false);
      const domain = pushDomain();
      // Delete every server record we registered.
      if (client) {
        for (const id of loadRegisteredIds()) {
          await client.deleteSubscription(id, domain).catch(() => {});
        }
      }
      saveRegisteredIds([]);
      try {
        const reg = preparedRef.current?.registration ?? await navigator.serviceWorker.ready;
        const sub = await reg.pushManager.getSubscription();
        if (sub) await sub.unsubscribe();
      } catch {
        // ignore
      }
      lastSynced.current = null;
      setEnabled(false);
    } finally {
      setBusy(false);
    }
  }, [client]);

  const setPrefs = useCallback(
    async (next: PushPrefs) => {
      setPrefsState(next);
      savePrefs(next);
      // The specs recompute from `prefs`; force the sync effect to re-run.
      lastSynced.current = null;
      setNonce((n) => n + 1);
    },
    [],
  );

  const retrySetup = useCallback(() => {
    setError(undefined);
    lastSynced.current = null;
    retry.current = 0;
    if (ready) setNonce((n) => n + 1);
    else setPrepareNonce((n) => n + 1);
  }, [ready]);

  return {
    supported,
    unavailableReason,
    ready,
    error,
    permission,
    enabled,
    busy: busy || (supported && !ready && !error),
    prefs,
    enable,
    disable,
    setPrefs,
    retry: retrySetup,
  };
}
