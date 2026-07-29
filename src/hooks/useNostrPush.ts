import { useNostr } from "@nostrify/react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import { useAppContext } from "@/hooks/useAppContext";
import { useCurrentUser } from "@/hooks/useCurrentUser";
import { useDmRelayList } from "@/hooks/useDmRelayList";
import { useFollowList } from "@/hooks/useFollowList";
import { useNotifLevels } from "@/hooks/useNotifLevels";
import { useUserGroupList } from "@/hooks/useUserGroupList";
import { isNativeRuntime } from "@/hooks/useNativeNotifications";
import {
  DEFAULT_PUSH_PREFS,
  type PushPrefs,
  type UsePushNotificationsReturn,
} from "@/hooks/usePushNotifications";
import { effectiveDmRelays } from "@/contexts/AppContext";
import { useConcordList } from "@/concord-v1/hooks/useConcordList";
import { buildConcordSubs, type ConcordSub } from "@/concord-v1/lib/concordNotifications";
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
 * (`useNativeNotifications`): the same groups, mentions-only levels,
 * friends-only DMs, and Concord V1/V2 channels — turned into content-blind
 * subscriptions by `buildPushSubscriptions`, then registered with the server.
 * It self-gates: `supported` is false unless a nostr-push server is configured
 * for this build and the signer can NIP-44.
 *
 * Exposes the same interface as `usePushNotifications` so the settings UI can
 * pick whichever path is active.
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

export function useNostrPush(): UsePushNotificationsReturn {
  const { user } = useCurrentUser();
  const { nostr } = useNostr();
  const { config } = useAppContext();
  const { data: groupList } = useUserGroupList();
  const { data: followData } = useFollowList();
  const { data: concordData } = useConcordList();
  const { channelLevel, concordChannelLevel } = useNotifLevels();
  const { relays: publishedDmRelays } = useDmRelayList();
  const allConcord2Subs = useConcord2Subs();

  const supported =
    nostrPushConfigured() &&
    !isNativeRuntime() &&
    typeof window !== "undefined" &&
    "serviceWorker" in navigator &&
    "PushManager" in window &&
    "Notification" in window;

  const [permission, setPermission] = useState<NotificationPermission>(
    typeof Notification !== "undefined" ? Notification.permission : "default",
  );
  const [enabled, setEnabled] = useState(false);
  const [busy, setBusy] = useState(false);
  const [prefs, setPrefsState] = useState<PushPrefs>(loadPrefs);

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

  const concordV1 = useMemo<ConcordSub[]>(
    () =>
      buildConcordSubs(concordData?.list).filter((sub) => {
        const channelId = sub.keys[0]?.channelId;
        if (!channelId) return true;
        return concordChannelLevel("c1", sub.communityId, channelId) === "all";
      }),
    [concordData, concordChannelLevel],
  );

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
      concordV1,
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
    concordV1,
    concordV2,
  ]);

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

  /** Ensure a current browser subscription, register the specs, prune stale. */
  const sync = useCallback(async () => {
    if (!client || !user) throw new Error("Push not available");
    const domain = pushDomain();
    const reg = await navigator.serviceWorker.ready;

    // VAPID key (cached per domain; refetched on a stored-key miss).
    let vapid: string;
    try {
      vapid = localStorage.getItem(`${VAPID_KEY}:${domain}`) || "";
    } catch {
      vapid = "";
    }
    if (!vapid) {
      vapid = await client.getVapidKey(domain);
      try {
        localStorage.setItem(`${VAPID_KEY}:${domain}`, vapid);
      } catch {
        // ignore
      }
    }
    const key = urlBase64ToBuffer(vapid);

    let sub = await reg.pushManager.getSubscription();
    if (sub && !matchesServerKey(sub, key)) {
      try {
        await sub.unsubscribe();
      } catch {
        // ignore
      }
      sub = null;
    }
    if (!sub) {
      sub = await reg.pushManager.subscribe({
        userVisibleOnly: true,
        applicationServerKey: key,
      });
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

  // Restore enabled state on mount: granted permission + an existing browser
  // subscription means we're active.
  useEffect(() => {
    if (!supported) return;
    let cancelled = false;
    (async () => {
      try {
        const reg = await navigator.serviceWorker.ready;
        const existing = await reg.pushManager.getSubscription();
        if (!cancelled && existing && Notification.permission === "granted") {
          setEnabled(true);
        }
      } catch {
        // leave disabled
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [supported]);

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
    if (!supported || !client || !user) return;
    if (Notification.permission !== "granted") return;
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
        setEnabled(true);
      } catch (err) {
        if (cancelled) return;
        console.warn("[nostr-push] sync failed:", err);
        if (retry.current < 3) {
          const delay = 10_000 * 2 ** retry.current;
          retry.current += 1;
          timer = setTimeout(() => setNonce((n) => n + 1), delay);
        }
      }
    })();
    return () => {
      cancelled = true;
      if (timer) clearTimeout(timer);
    };
  }, [supported, client, user, specs.length, syncSig, sync, nonce]);

  // A rotated browser subscription (SW pushsubscriptionchange → message) must
  // be re-registered with the server.
  useEffect(() => {
    if (!supported) return;
    const onMessage = (event: MessageEvent) => {
      if (event.data?.type !== "armada-push-changed") return;
      lastSynced.current = null;
      retry.current = 0;
      setNonce((n) => n + 1);
    };
    navigator.serviceWorker.addEventListener("message", onMessage);
    return () => navigator.serviceWorker.removeEventListener("message", onMessage);
  }, [supported]);

  // ── Public actions ─────────────────────────────────────────────────────────

  const enable = useCallback(async () => {
    if (!supported || !user) return;
    setBusy(true);
    try {
      const perm = await Notification.requestPermission();
      setPermission(perm);
      if (perm !== "granted") return;
      saveIntent(true);
      lastSynced.current = null;
      await sync();
      lastSynced.current = syncSig;
      setEnabled(true);
    } finally {
      setBusy(false);
    }
  }, [supported, user, sync, syncSig]);

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
        const reg = await navigator.serviceWorker.ready;
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

  return { supported, permission, enabled, busy, prefs, enable, disable, setPrefs };
}
