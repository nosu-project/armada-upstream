import { useNostr } from "@nostrify/react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import { useCurrentUser } from "@/hooks/useCurrentUser";
import { usePushWatchSet } from "@/hooks/usePushWatchSet";
import {
  ArmadaPush,
  clearIosPushConfig,
  hasIosPush,
  pushInstallationId,
  writeIosPushConfig,
} from "@/lib/nativePush";
import { queryDm17Conversations } from "@/lib/nip17/dm17Store";
import { NostrPushClient, type PushRelayPool, type PushSigner } from "@/lib/nostrPush";
import {
  NOSTR_PUSH_PUBKEY,
  NOSTR_PUSH_RELAYS,
  nostrPushConfigured,
} from "@/lib/platform";
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
import {
  scopePushSubscriptionId,
  standaloneNotification,
} from "@/lib/pushSubscriptions";
import { PUBLIC_WEB_ORIGIN } from "@/lib/shareOrigin";

/**
 * useIosPush
 *
 * Background notifications for the iOS app, against the SAME content-blind
 * nostr-push gateway (NIP-PUSH) the web client uses — only the last hop
 * differs. The app takes an APNs device token from
 * `ArmadaPushPlugin.swift` and registers it as a `type: "apns"` subscription
 * carrying exactly the filters `useNostrPush` registers as `type: "web"`
 * (`usePushWatchSet`), so the two platforms watch one watch set.
 *
 * Apple is in the delivery path and cannot be taken out of it — iOS has no
 * equivalent of the Android foreground service, and WKWebView has no Web Push,
 * so this is the only route to a notification while Armada is closed. What it
 * does keep is the gateway's content-blindness: it matches kinds and tags and
 * sends a fixed string, never a rendered message.
 *
 * What the lock screen SHOWS is decided on the device, by the Notification
 * Service Extension (`ios/App/NotificationService`, over the `ArmadaNotify`
 * package): the gateway inlines the matched event, the extension opens it,
 * writes it into the same ArmadaDB the WebView reads, and rewrites the
 * notification from the plaintext. That is the third port of the pipeline
 * `sw.js` + `pushRuntime.ts` are on the web and `Dm17.kt` + `ServiceStore.kt`
 * are on Android.
 *
 * This hook's job on that front is `writeIosPushConfig`: the extension runs in
 * its own process with no WebView and no localStorage, so everything it needs
 * to decrypt has to be put somewhere it can read first.
 *
 * Exposes the shared `UsePushNotificationsReturn` the settings UI drives, so
 * `NotificationSettings` needs to know nothing about which one it has.
 */

/** Retries for a transient sync failure, matching the web controller. */
const MAX_SYNC_RETRIES = 3;

/**
 * How long the config write will wait on the DM store before giving up on the
 * "conversations I have written in" set and writing without it.
 */
const MINE_PEERS_TIMEOUT_MS = 3_000;

function errorText(err: unknown): string {
  const message = err instanceof Error ? err.message : String(err);
  return message.replace(/\s+/g, " ").trim();
}

/**
 * The `domain` every RPC is scoped by.
 *
 * NIP-PUSH wants "a valid hostname matching the app's origin", which the app
 * does not have: WKWebView serves it from `capacitor://localhost`, a name every
 * Capacitor app on earth shares. It uses the public deployment's host instead —
 * the same origin `shareOrigin()` builds links on and the AASA file associates
 * — so the gateway's per-domain quota counts this account's iPhone against the
 * same deployment its browser counts against, which is the honest answer.
 * Sharing the domain with the web client is exactly why subscription ids carry
 * an installation id (`pushInstallationId`).
 */
function pushDomain(): string {
  try {
    return new URL(PUBLIC_WEB_ORIGIN).hostname;
  } catch {
    return "armada.buzz";
  }
}

export function useIosPush(): UsePushNotificationsReturn {
  const { user } = useCurrentUser();
  const { nostr } = useNostr();

  const unavailableReason = !hasIosPush()
    ? "native-runtime" as const
    : !nostrPushConfigured()
      ? "gateway" as const
      : undefined;
  const supported = unavailableReason === undefined;

  const [permission, setPermission] = useState<NotificationPermission>("default");
  const [enabled, setEnabled] = useState(false);
  const [busy, setBusy] = useState(false);
  const [ready, setReady] = useState(false);
  const [error, setError] = useState<string>();
  /** A failed config write, reported separately from sync failures. */
  const [configError, setConfigError] = useState<string>();
  const [prefs, setPrefsState] = useState<PushPrefs>(loadPushPrefs);
  const [nonce, setNonce] = useState(0);

  const { specs, concord, dmKnownPeers, dmSk, dmBunker, followsLoading } = usePushWatchSet(prefs);

  // Keep the extension's config current: the DM policy and known set for every
  // enabled session, the decrypt key for nsec logins, and the per-channel
  // Concord stream keys. Cleared whenever push is off or logged out, so no key
  // lingers past a session that can use it.
  useEffect(() => {
    if (!supported || !user || !enabled) {
      void clearIosPushConfig();
      return;
    }
    // Wait for the follow list: writing a config while it loads would freeze an
    // empty known set on disk, reclassifying every known conversation as a
    // request until the next rewrite.
    if (followsLoading) return;
    let cancelled = false;
    (async () => {
      // Mirror useKnownDmPeers' `mine` dimension: a conversation the viewer has
      // authored a message in is known even where `acceptedDms` cannot say so
      // (it is device-local, so a fresh install starts it empty while the
      // synced history still shows the viewer's own messages).
      //
      // RACED AGAINST A TIMEOUT, because this is an enhancement and the write
      // below is not. It reads ArmadaDB, and a store that is slow — or wedged,
      // which on this platform is a real state — must not be able to stop the
      // extension's config from being written at all. That failure mode is
      // invisible from the device: every push just quietly falls back to the
      // gateway's static text, with nothing to say why.
      let minePeers: string[] = [];
      try {
        const rows = await Promise.race([
          queryDm17Conversations(user.pubkey),
          new Promise<null>((resolve) => setTimeout(() => resolve(null), MINE_PEERS_TIMEOUT_MS)),
        ]);
        if (rows) minePeers = rows.filter((row) => row.mine).map((row) => row.peer);
      } catch {
        // Store unavailable — follows ∪ accepted ∪ pinned still apply.
      }
      if (cancelled) return;
      await writeIosPushConfig({
        policy: prefs.dmRequests,
        self: user.pubkey,
        knownPeers: [...new Set([...dmKnownPeers, ...minePeers])].sort(),
        // One entry per watched channel's CURRENT epoch. The conversation key
        // reads that channel at that epoch and nothing else — the wrap-signing
        // secret stays in the page — and the set goes stale by itself at the
        // next rekey, which `concord` changing rewrites.
        concord: concord.flatMap((sub) =>
          sub.streams.map((stream) => ({
            pk: stream.pk,
            convKey: stream.convKey,
            epoch: stream.epoch,
            communityId: sub.communityId,
            channelId: sub.channelId,
          }))
        ),
        // An nsec login decrypts on the device; a bunker login hands over the
        // client key so the extension can ask the bunker instead. Never both —
        // a login is one or the other.
        ...(dmSk ? { sk: dmSk } : {}),
        ...(!dmSk && dmBunker ? { nip46: dmBunker } : {}),
      });
      if (!cancelled) setConfigError(undefined);
    })().catch((err) => {
      if (cancelled) return;
      // NOT swallowed. Without a config the extension cannot open anything, so
      // every notification silently degrades to "New direct message" — the one
      // symptom that looks identical to "the feature isn't built yet". Say so
      // where the user can read it.
      console.warn("[ios-push] writing the extension config failed:", err);
      setConfigError(
        `Armada couldn't hand its notification extension the keys it needs, so `
        + `notifications can't show who a message is from. ${errorText(err)}`,
      );
    });
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
    dmBunker,
    concord,
  ]);

  const client = useMemo(() => {
    if (!supported || !user || !NOSTR_PUSH_PUBKEY) return undefined;
    return new NostrPushClient({
      serverPubkey: NOSTR_PUSH_PUBKEY,
      relays: NOSTR_PUSH_RELAYS,
      signer: user.signer as unknown as PushSigner,
      pool: nostr as unknown as PushRelayPool,
    });
  }, [supported, user, nostr]);

  // Read the authorization status without prompting. Unlike Web Push there is
  // nothing to prepare — no service worker, no VAPID key — so `ready` is just
  // "we have asked the OS what it thinks", and the enable action does not have
  // to be gesture-bound.
  useEffect(() => {
    if (!supported) {
      setReady(false);
      return;
    }
    let cancelled = false;
    (async () => {
      const { status } = await ArmadaPush.permission();
      if (cancelled) return;
      setPermission(status === "default" ? "default" : status);
      setReady(true);
    })().catch(() => {
      if (cancelled) return;
      // The plugin is present (hasIosPush) but did not answer — treat it as an
      // ordinary recoverable failure rather than as an unsupported platform.
      setReady(false);
      setError("Armada couldn't check its notification permission. Try again.");
    });
    return () => {
      cancelled = true;
    };
  }, [supported, nonce]);

  /**
   * Re-take the device token and register the current specs.
   *
   * The token is re-taken on every sync rather than cached across launches
   * because APNs may hand back a different one at any time (a restore from
   * backup, or the OS simply rotating it), and a stale token is not an error
   * anyone reports — it is a device that silently stops receiving. Asking is
   * cheap: after the first authorization, `register()` prompts for nothing.
   */
  const sync = useCallback(async () => {
    if (!client || !user) throw new Error("Push not ready");
    const registration = await ArmadaPush.register();
    if (!registration.granted) {
      setPermission("denied");
      throw new Error("Notification permission not granted");
    }
    if (!registration.token || !registration.bundleId) {
      throw new Error(registration.error || "APNs returned no device token");
    }
    setPermission("granted");

    const domain = pushDomain();
    const pushSubscription = {
      type: "apns" as const,
      device_token: registration.token,
      bundle_id: registration.bundleId,
      ...(registration.environment ? { environment: registration.environment } : {}),
    };

    const installation = pushInstallationId();
    const scopedSpecs = specs.map((spec) => ({
      ...spec,
      id: scopePushSubscriptionId(spec.id, user.pubkey, domain, installation),
      notification: standaloneNotification(spec),
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

    // Prune gateway records we no longer want (left group, muted, logged out).
    const currentIds = new Set(scopedSpecs.map((s) => s.id));
    for (const id of loadRegisteredPushIds()) {
      if (!currentIds.has(id)) {
        await client.deleteSubscription(id, domain).catch(() => {});
      }
    }
    saveRegisteredPushIds([...currentIds]);
  }, [client, user, specs]);

  // Auto-(re)sync whenever the watch set changes, exactly as the web
  // controller does: as long as the user intends push and the OS has granted
  // it, the gateway's records stay current without a visit to Settings.
  const syncSig = useMemo(
    () => JSON.stringify({ pubkey: user?.pubkey, specs }),
    [user?.pubkey, specs],
  );
  const lastSynced = useRef<string | null>(null);
  const retry = useRef(0);
  const hadSpecs = useRef(false);
  useEffect(() => {
    if (!supported || !ready || !client || !user) return;
    if (permission !== "granted") return;
    if (!loadPushIntent()) return;
    // Empty specs is ambiguous — "still loading" on a cold start, "was
    // watching, now nothing" once something is registered — and only the second
    // must run, so `sync` prunes the stale gateway records. The persisted id
    // list is the durable half of that answer, since registrations outlive the
    // process and a session ref cannot see across a relaunch.
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
        console.warn("[ios-push] sync failed:", err);
        if (retry.current < MAX_SYNC_RETRIES) {
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

  // Coming back to the foreground: clear the badge and the delivered pile the
  // user has now seen, and recheck a permission they may have changed in
  // Settings while Armada was away (revoking it, or granting it back — the
  // latter is repaired by the sync effect above once `permission` updates).
  useEffect(() => {
    if (!supported) return;
    let cancelled = false;
    const onVisible = () => {
      if (document.visibilityState !== "visible") return;
      void ArmadaPush.clearBadge().catch(() => {});
      ArmadaPush.permission()
        .then(({ status }) => {
          if (cancelled) return;
          setPermission(status === "default" ? "default" : status);
          setEnabled(status === "granted" && loadPushIntent());
        })
        .catch(() => {});
    };
    onVisible();
    document.addEventListener("visibilitychange", onVisible);
    return () => {
      cancelled = true;
      document.removeEventListener("visibilitychange", onVisible);
    };
  }, [supported]);

  // ── Public actions ─────────────────────────────────────────────────────────

  const enable = useCallback(async () => {
    if (!supported || !ready || !user) return;
    setBusy(true);
    setError(undefined);
    try {
      savePushIntent(true);
      lastSynced.current = null;
      await sync();
      lastSynced.current = syncSig;
      setEnabled(true);
    } catch (err) {
      // A refused prompt is the user's answer, not a fault to report: `sync`
      // has already set permission to "denied" and the UI explains that state.
      const { status } = await ArmadaPush.permission().catch(() => ({ status: permission }));
      setPermission(status === "default" ? "default" : status);
      if (status !== "denied") {
        console.warn("[ios-push] enable failed:", err);
        setError("Armada couldn't enable background notifications. Check your connection and retry.");
      }
    } finally {
      setBusy(false);
    }
  }, [supported, ready, user, sync, syncSig, permission]);

  const disable = useCallback(async () => {
    setBusy(true);
    try {
      // Intent first, and locally: everything below goes over the network or
      // the bridge and can fail, and "off" must not depend on the gateway
      // honoring the deletes. The sync effect reads this on every pass, so a
      // half-finished teardown does not resurrect itself.
      savePushIntent(false);
      const domain = pushDomain();
      if (client) {
        for (const id of loadRegisteredPushIds()) {
          await client.deleteSubscription(id, domain).catch(() => {});
        }
      }
      saveRegisteredPushIds([]);
      // Give up the token too. Deleting the gateway records is what actually
      // stops the pushes; this makes the device stop holding a token the app no
      // longer uses, and any push racing the deletes has nowhere to land.
      await ArmadaPush.unregister().catch(() => {});
      // The identity key must not outlive the session that could use it.
      await clearIosPushConfig();
      lastSynced.current = null;
      setEnabled(false);
    } finally {
      setBusy(false);
    }
  }, [client]);

  const setPrefs = useCallback(async (next: PushPrefs) => {
    setPrefsState(next);
    savePushPrefs(next);
    // The specs recompute from `prefs`; force the sync effect to re-run.
    lastSynced.current = null;
    setNonce((n) => n + 1);
  }, []);

  const retrySetup = useCallback(() => {
    setError(undefined);
    lastSynced.current = null;
    retry.current = 0;
    setNonce((n) => n + 1);
  }, []);

  return {
    supported,
    unavailableReason,
    ready,
    error: error ?? configError,
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
