import { useNostr } from "@nostrify/react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import { useCurrentUser } from "@/hooks/useCurrentUser";
import { useAppContext } from "@/hooks/useAppContext";
import { useMediaPolicyConfig } from "@/hooks/useMediaPolicy";
import { usePushWatchSet } from "@/hooks/usePushWatchSet";
import {
  ArmadaPush,
  clearIosPushConfig,
  hasIosPush,
  writeIosPushConfig,
  recordPushStatus,
} from "@/lib/nativePush";
import { queryDm17Conversations } from "@/lib/nip17/dm17Store";
import { NostrPushClient, type PushRelayPool, type PushSigner } from "@/lib/nostrPush";
import {
  NOSTR_PUSH_PUBKEY,
  NOSTR_PUSH_RELAYS,
  nostrPushConfigured,
} from "@/lib/platform";
import {
  type PushPrefs,
  type UsePushNotificationsReturn,
} from "@/lib/pushPrefs";
import {
  loadPushIntent,
  loadRegisteredPushIds,
  pushInstallationId,
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
 * Background notifications for the iOS app via the same content-blind NIP-PUSH gateway as
 * the web: registers an APNs token as a `type: "apns"` subscription with the same filters as
 * `useNostrPush` (`usePushWatchSet`).
 * The Notification Service Extension (`ios/App/NotificationService`) decrypts the inlined event and
 * rewrites the notification; `writeIosPushConfig` gives it what it needs, since it has no WebView or
 * localStorage.
 */

/** Retries for a transient sync failure, matching the web controller. */
const MAX_SYNC_RETRIES = 3;

/** Max wait on the DM store for the authored-conversations set before writing without it. */
const MINE_PEERS_TIMEOUT_MS = 3_000;

function errorText(err: unknown): string {
  const message = err instanceof Error ? err.message : String(err);
  return message.replace(/\s+/g, " ").trim();
}

/**
 * NIP-PUSH wants a hostname matching the app's origin, but WKWebView uses the shared
 * `capacitor://localhost`, so use the public deployment's host (as `shareOrigin()` does).
 * Subscription ids carry an installation id (`pushInstallationId`) since the web shares the domain.
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
  const { config, updateConfig } = useAppContext();

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
  const [configError, setConfigError] = useState<string>();
  const prefs = config.pushPrefs;
  const [nonce, setNonce] = useState(0);

  const {
    specs,
    concord,
    dmKnownPeers,
    dmKnownConversationKeys,
    dmMutedPeers,
    dmLevels,
    dmSk,
    dmBunker,
    configReady,
    watchSetLoading,
  } = usePushWatchSet(prefs);
  const mediaPolicy = useMediaPolicyConfig();

  // Keep the extension's config current; cleared whenever push is off or logged out so no key
  // lingers.
  useEffect(() => {
    if (!supported || !user || !enabled) {
      void clearIosPushConfig();
      return;
    }
    // Writing while the roster loads would freeze an empty known set on disk.
    if (!configReady) return;
    let cancelled = false;
    (async () => {
      // Mirror useKnownDmPeers' `mine` dimension (`acceptedDms` is device-local). Raced against a
      // timeout: a slow/wedged store must not block the config write.
      let mineConversationKeys: string[] = [];
      try {
        const rows = await Promise.race([
          queryDm17Conversations(user.pubkey),
          new Promise<null>((resolve) => setTimeout(() => resolve(null), MINE_PEERS_TIMEOUT_MS)),
        ]);
        // An authored group doesn't make its participants trusted in unrelated 1:1s.
        if (rows) {
          const muted = new Set(dmMutedPeers);
          mineConversationKeys = rows
            .filter((row) => row.mine && row.peers.every((peer) => !muted.has(peer)))
            .map((row) => row.key);
        }
      } catch {
        // Store unavailable — the durable synced/pinned roster still applies.
      }
      if (cancelled) return;
      await writeIosPushConfig({
        policy: prefs.dmRequests,
        directMessages: prefs.directMessages,
        dmLevels,
        self: user.pubkey,
        knownPeers: dmKnownPeers,
        knownConversations: [
          ...new Set([...dmKnownConversationKeys, ...mineConversationKeys]),
        ].sort(),
        mutedPeers: dmMutedPeers,
        // One entry per watched channel's CURRENT epoch; the wrap-signing secret stays in the page,
        // and a rekey rewrites the set.
        concord: concord.flatMap((sub) =>
          sub.streams.map((stream) => ({
            pk: stream.pk,
            convKey: stream.convKey,
            epoch: stream.epoch,
            communityId: sub.communityId,
            channelId: sub.channelId,
            banned: sub.banned,
            mentionEveryoneAuthors: sub.mentionEveryoneAuthors,
            mentionOnly: sub.mentionOnly,
            muted: sub.muted,
          }))
        ),
        // nsec logins decrypt on device; bunker logins hand over the client key. Never both.
        ...(dmSk ? { sk: dmSk } : {}),
        ...(!dmSk && dmBunker ? { nip46: dmBunker } : {}),
        mediaPolicy,
      });
      if (!cancelled) setConfigError(undefined);
    })().catch((err) => {
      if (cancelled) return;
      // NOT swallowed: without a config every notification silently degrades to static text.
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
    configReady,
    prefs.dmRequests,
    prefs.directMessages,
    dmKnownPeers,
    dmKnownConversationKeys,
    dmMutedPeers,
    dmLevels,
    dmSk,
    dmBunker,
    concord,
    mediaPolicy,
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

  // Read authorization without prompting; no worker or VAPID key needed, so enable needn't be
  // gesture-bound.
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
      // Plugin present but unresponsive: a recoverable failure, not an unsupported platform.
      setReady(false);
      setError("Armada couldn't check its notification permission. Try again.");
    });
    return () => {
      cancelled = true;
    };
  }, [supported, nonce]);

  /**
   * The token is re-taken on every sync since APNs may rotate it silently; `register()` prompts
   * for nothing after the first authorization.
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
      replacementIds: (spec.replaces ?? []).map((logicalId) =>
        scopePushSubscriptionId(logicalId, user.pubkey, domain, installation)),
      notification: standaloneNotification(spec),
    }));

    // One at a time: the gateway REFUSES new ids past its per (pubkey, domain) quota, so partial
    // success is real and the failing index is reported.
    let registered = 0;
    const trackedIds = new Set(loadRegisteredPushIds());
    try {
      for (const spec of scopedSpecs) {
        const registerAs = (id: string) => client.registerSubscription({
          subscription_id: id,
          domain,
          filter: spec.filter,
          relays: spec.relays,
          notification: spec.notification,
          push_subscription: pushSubscription,
        });
        const removed: string[] = [];
        // A flat NIP-29 record may hold the last quota slot; release it on an authoritative pass
        // before the per-relay PUTs.
        if (!watchSetLoading) {
          for (const oldId of spec.replacementIds) {
            if (!trackedIds.has(oldId) || oldId === spec.id) continue;
            await client.deleteSubscription(oldId, domain);
            trackedIds.delete(oldId);
            removed.push(oldId);
            saveRegisteredPushIds([...trackedIds]);
          }
        }
        try {
          await registerAs(spec.id);
        } catch (error) {
          // Best-effort rollback; replaced again on the next retry.
          for (const oldId of removed) {
            await registerAs(oldId).then(() => {
              trackedIds.add(oldId);
              saveRegisteredPushIds([...trackedIds]);
            }).catch(() => undefined);
          }
          throw error;
        }
        trackedIds.add(spec.id);
        saveRegisteredPushIds([...trackedIds]);
        registered += 1;
      }
    } catch (err) {
      const reason = err instanceof Error ? err.message : String(err);
      await recordPushStatus(
        `FAILED after ${registered}/${scopedSpecs.length} on ${domain}`
          + ` env=${registration.environment ?? "?"} token=…${registration.token.slice(-6)}`
          + ` — ${reason}`,
      );
      throw err;
    }

    // Prune only once the watch set has settled: registering from a partial set is harmless,
    // deleting from one silently stops notifications.
    const currentIds = new Set(scopedSpecs.map((s) => s.id));
    // `watchSetLoading` already waits for Concord folds, so an empty Concord set here is real.
    const registeredIds = [...trackedIds];
    if (watchSetLoading) {
      await recordPushStatus(
        `ok ${registered} subs on ${domain} (partial — prune deferred)`
          + ` env=${registration.environment ?? "?"} token=…${registration.token.slice(-6)}`,
      );
      return;
    }
    for (const id of registeredIds) {
      if (!currentIds.has(id)) {
        await client.deleteSubscription(id, domain).catch(() => {});
      }
    }
    saveRegisteredPushIds([...currentIds]);
    // Recorded because the gateway's own relay set (`NOSTR_PUSH_RELAYS`) can make a broken watch
    // set look healthy.
    const dmRelays = specs.find((spec) => spec.id === "armada-dm17")?.relays ?? [];
    await recordPushStatus(
      `ok ${registered} subs on ${domain} dmRelays=[${dmRelays.join(" ")}]`
        + ` env=${registration.environment ?? "?"} token=…${registration.token.slice(-6)}`,
    );
  }, [client, user, specs, watchSetLoading]);

  // Auto-(re)sync on watch-set changes while intent + permission hold, like the web controller.
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
    // Empty specs is ambiguous (loading vs. now nothing); only the latter should sync to prune.
    // The persisted id list survives relaunches.
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

  // On foreground: clear the badge and delivered notifications, and recheck permission.
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
      // A refused prompt is the user's answer, not a fault.
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
      // Intent first and locally: "off" must not depend on the gateway honoring deletes.
      savePushIntent(false);
      const domain = pushDomain();
      if (client) {
        for (const id of loadRegisteredPushIds()) {
          await client.deleteSubscription(id, domain).catch(() => {});
        }
      }
      saveRegisteredPushIds([]);
      // Deleting gateway records stops pushes; this also drops the unused token.
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
    savePushPrefs(next, user?.pubkey);
    updateConfig((current) => ({ ...current, pushPrefs: next }));
    // The specs recompute from `prefs`; force the sync effect to re-run.
    lastSynced.current = null;
    setNonce((n) => n + 1);
  }, [updateConfig, user?.pubkey]);

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
