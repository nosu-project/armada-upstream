import { useNostr } from "@nostrify/react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import { useCurrentUser } from "@/hooks/useCurrentUser";
import { isNativeRuntime } from "@/hooks/useNativeNotifications";
import { usePushWatchSet } from "@/hooks/usePushWatchSet";
import { clearSwPushConfig, writeSwPushConfig } from "@/lib/swPushConfig";
import { clearPushDisabledFlag, writePushDisabledFlag } from "@/lib/swPushDisabled";
import { queryDm17Conversations } from "@/lib/nip17/dm17Store";
import {
  loadPushPrefs,
  type PushPrefs,
  type UsePushNotificationsReturn,
} from "@/lib/pushPrefs";
import {
  loadPushIntent,
  loadRegisteredPushIds,
  savePushIntent,
  savePushPrefs,
  saveRegisteredPushIds,
} from "@/lib/pushRegistry";
import { NostrPushClient, type PushRelayPool, type PushSigner } from "@/lib/nostrPush";
import { scopePushSubscriptionId } from "@/lib/pushSubscriptions";
import {
  NOSTR_PUSH_PUBKEY,
  NOSTR_PUSH_RELAYS,
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
 * The watch set it registers is `usePushWatchSet` — the same groups,
 * mentions-only levels, addressed NIP-17 wraps, friends-only legacy DMs and
 * Concord channels the native Android background service watches
 * (`useNativeNotifications`), and the same ones the iOS APNs controller
 * registers (`useIosPush`). Only the transport differs between the two: this
 * one registers a browser Web Push subscription, that one a device token.
 * It self-gates: `supported` is false unless a nostr-push server is configured
 * for this build and the signer can NIP-44.
 *
 * Exposes the shared `UsePushNotificationsReturn` interface the settings UI
 * drives.
 */

/** Per-domain VAPID key cache (avoids an RPC round-trip on every load). */
const VAPID_KEY = "armada:nostr-push-vapid";

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
  const [prefs, setPrefsState] = useState<PushPrefs>(loadPushPrefs);
  const preparedRef = useRef<PreparedPush | undefined>(undefined);

  // The watch set — the same one the Android background service uses, and the
  // one the APNs controller registers (`usePushWatchSet`).
  const { specs, concord, dmKnownPeers, dmSk, followsLoading } = usePushWatchSet(prefs);

  // Keep the service worker's push config current — the DM policy + known set
  // for every enabled web-push session, the decrypt key for nsec logins, and
  // the per-channel Concord stream keys. Cleared whenever push is off or logged
  // out, so no key lingers past a session that can use it.
  //
  // Display data is deliberately NOT sealed here. The worker reads names,
  // avatars, community icons and channel titles out of ArmadaDB at push time
  // (`pushRuntime.ts`) — IndexedDB is reachable from a worker, which the
  // earlier snapshot wrongly assumed it wasn't. That removed a whole failure
  // mode: a config sealed while the kind-0 rows were still cold used to stay
  // nameless for the session, so it needed timed re-seals to catch profiles
  // that landed late, and it could only ever name a pre-listed peer.
  useEffect(() => {
    if (!supported || !user || !enabled) {
      void clearSwPushConfig();
      return;
    }
    // Wait for the follow list: sealing a config while it loads would freeze
    // an empty known set on disk, reclassifying every known conversation as a
    // request until the next rewrite.
    if (followsLoading) return;
    let cancelled = false;
    (async () => {
      // Mirror useKnownDmPeers' `mine` dimension: a conversation the viewer
      // has authored a message in is known even where `acceptedDms` can't say
      // so (it is device-local, so a fresh install starts it empty while the
      // synced history still shows the viewer's own messages).
      let minePeers: string[] = [];
      try {
        const rows = await queryDm17Conversations(user.pubkey);
        minePeers = rows.filter((row) => row.mine).map((row) => row.peer);
      } catch {
        // Store unavailable — follows ∪ accepted ∪ pinned still apply.
      }
      if (cancelled) return;
      await writeSwPushConfig({
        policy: prefs.dmRequests,
        self: user.pubkey,
        knownPeers: [...new Set([...dmKnownPeers, ...minePeers])].sort(),
        // One entry per watched channel's CURRENT epoch. The conversation key
        // reads that channel at that epoch and nothing else — the wrap-signing
        // secret stays in the page (see concordNotifications.ts) — and the set
        // goes stale by itself at the next rekey, which `concord` changing
        // rewrites.
        concord: concord.flatMap((sub) =>
          sub.streams.map((s) => ({
            pk: s.pk,
            convKey: s.convKey,
            epoch: s.epoch,
            communityId: sub.communityId,
            channelId: sub.channelId,
          }))
        ),
        ...(dmSk ? { sk: dmSk } : {}),
      });
    })();
    return () => {
      cancelled = true;
    };
  }, [
    supported,
    user,
    enabled,
    followsLoading,
    prefs.dmRequests,
    dmKnownPeers,
    dmSk,
    concord,
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
      let cached = "";
      try {
        cached = localStorage.getItem(`${VAPID_KEY}:${domain}`) || "";
      } catch {
        // Storage can be unavailable in private browsing; the RPC covers it.
      }
      // Always ask the gateway for the CURRENT key: the server can rotate a
      // domain's VAPID pair (e.g. regenerated key storage), and trusting the
      // cache would keep this install subscribed — and the gateway signing —
      // with keys that no longer match, which push services reject with 403
      // forever. The cache is only a fallback for an unreachable gateway.
      let vapid = "";
      try {
        vapid = await client.getVapidKey(domain);
      } catch (err) {
        if (!cached) throw err;
        vapid = cached;
      }
      if (vapid && vapid !== cached) {
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
      setEnabled(Boolean(current && nextPermission === "granted" && loadPushIntent()));
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

    // Registering below is the moment pushes can resume; lift the worker's
    // kill switch from any previous disable first, or it would tear this
    // fresh subscription down on the first push.
    await clearPushDisabledFlag();

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
    for (const id of loadRegisteredPushIds()) {
      if (!currentIds.has(id)) {
        await client.deleteSubscription(id, domain).catch(() => {});
      }
    }
    saveRegisteredPushIds([...currentIds]);
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
  // Whether this SESSION has registered a non-empty set. Only half the signal:
  // see the effect below, which also consults the persisted registration list.
  const hadSpecs = useRef(false);
  const [nonce, setNonce] = useState(0);
  useEffect(() => {
    if (!supported || !ready || !client || !user) return;
    if (permission !== "granted") return;
    if (!loadPushIntent()) return;
    // Empty specs is ambiguous: it means "still loading" on a cold start, and
    // "was watching, now nothing" once something has been registered — and only
    // the second must run, so `sync` prunes the stale server records instead of
    // leaving the gateway pushing for a community that is (say) now paused.
    //
    // The session ref alone can't tell them apart across a RESTART, which is
    // exactly when it matters: registrations are server-side and outlive the
    // tab, so a reload into a still-empty spec set would skip the prune forever
    // and the gateway would keep pushing. The persisted registration list is
    // the durable half of the answer — if it holds ids, something is registered
    // and the prune is owed regardless of what this session has seen.
    if (specs.length === 0 && !hadSpecs.current && loadRegisteredPushIds().length === 0) return;
    if (specs.length > 0) hadSpecs.current = true;
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
        setEnabled(Boolean(existing && nextPermission === "granted" && loadPushIntent()));
        if (!existing && nextPermission === "granted" && loadPushIntent()) {
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
      savePushIntent(true);
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
      savePushIntent(false);
      // Local truth first, where the worker can read it: everything after
      // this line goes over the network and can fail (or the page can die
      // mid-teardown), and the worker refuses — and tears down — pushes on
      // its own while this flag stands. "Off" must not depend on a flaky
      // gateway honoring the deletes below.
      await writePushDisabledFlag();
      const domain = pushDomain();
      // Delete every server record we registered.
      if (client) {
        for (const id of loadRegisteredPushIds()) {
          await client.deleteSubscription(id, domain).catch(() => {});
        }
      }
      saveRegisteredPushIds([]);
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
      savePushPrefs(next);
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
