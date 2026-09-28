import { useNostr } from "@nostrify/react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import { useAppContext } from "@/hooks/useAppContext";
import { useCurrentUser } from "@/hooks/useCurrentUser";
import { useMediaPolicyConfig } from "@/hooks/useMediaPolicy";
import { usePushWatchSet } from "@/hooks/usePushWatchSet";
import { registerBeforeAccountExit } from "@/lib/beforeAccountExit";
import { installCrossTabAccountExit } from "@/lib/crossTabAccountExit";
import { clearSwPushConfig, writeSwPushConfig } from "@/lib/swPushConfig";
import {
  activateRegisteredWebPush,
  acquireWebPushSubscription,
  finishWebPushAccountExit,
  matchesWebPushServerKey,
  retireWebPushEndpoint,
} from "@/lib/webPushEndpoint";
import { queryDm17Conversations } from "@/lib/nip17/dm17Store";
import type { PushPrefs, UsePushNotificationsReturn } from "@/lib/pushPrefs";
import {
  completePushIdMigration,
  loadPushIntent,
  loadPushRegistrationState,
  pushInstallationId,
  savePushIntent,
  savePushPrefs,
  savePushRegistrationState,
  type PushRegistryScope,
} from "@/lib/pushRegistry";
import {
  LatestSerialRunner,
  mergePushReplacementSpec,
  reconcilePushRegistrations,
} from "@/lib/pushRegistration";
import { isDesktop } from "@/lib/desktop";
import { NostrPushClient, type PushRelayPool, type PushSigner } from "@/lib/nostrPush";
import {
  scopePushSubscriptionId,
  type PushSubscriptionSpec,
} from "@/lib/pushSubscriptions";
import {
  NOSTR_PUSH_PUBKEY,
  NOSTR_PUSH_RELAYS,
  isNativeRuntime,
  nostrPushConfigured,
} from "@/lib/platform";
import {
  notificationPermissionOf,
  webPushUnavailableReason,
} from "@/lib/webPushSupport";

/**
 * Web Push via a content-blind NIP-PUSH gateway: it matches our raw filters and sends a
 * static wake-up; `sw.js` fetches and decrypts the event. The watch set is `usePushWatchSet` (shared
 * with the Android service and `useIosPush`). `supported` is false unless a gateway is configured and
 * the signer can NIP-44.
 */

const VAPID_KEY = "armada:nostr-push-vapid";

function urlBase64ToBuffer(base64String: string): ArrayBuffer {
  const padding = "=".repeat((4 - (base64String.length % 4)) % 4);
  const base64 = (base64String + padding).replace(/-/g, "+").replace(/_/g, "/");
  const raw = atob(base64);
  const buffer = new ArrayBuffer(raw.length);
  const view = new Uint8Array(buffer);
  for (let i = 0; i < raw.length; i++) view[i] = raw.charCodeAt(i);
  return buffer;
}

function pushDomain(): string {
  return typeof location !== "undefined" ? location.hostname : "";
}

interface PreparedPush {
  registration: ServiceWorkerRegistration;
  key: ArrayBuffer;
  options: PushSubscriptionOptionsInit;
}

export interface WebPushSyncJob {
  kind: "sync";
  client: NostrPushClient;
  pubkey: string;
  domain: string;
  installation: string;
  prepared: PreparedPush;
  specs: PushSubscriptionSpec[];
  /** False for an additive cold-load snapshot that must never prune. */
  authoritative: boolean;
  /** Whether the account's notification policy (NIP-78/local opt-out) is trusted. */
  notificationSettingsReady: boolean;
  groupPlaneReady: boolean;
  dmPlaneReady: boolean;
  concordPlaneReady: boolean;
  /** Seal this account's policy/keys before its endpoint may be exposed. */
  prepareConfig: (isCurrent: () => boolean) => Promise<void>;
  gestureSubscription?: PushSubscription;
}

interface WebPushDeleteJob {
  kind: "delete";
  client: NostrPushClient;
  pubkey: string;
  domain: string;
  installation: string;
  legacyIds: string[];
}

type WebPushMutationJob = WebPushSyncJob | WebPushDeleteJob;

export interface WebPushMutationResult {
  completed: boolean;
  activated: boolean;
  /** Additive records that didn't fit/reach the gateway and need a retry. */
  deferredRegistrations: string[];
}

function registryScopeOf(job: WebPushMutationJob): PushRegistryScope {
  return {
    pubkey: job.pubkey,
    domain: job.domain,
    installation: job.installation,
  };
}

export async function mutateWebPushRegistrations(
  job: WebPushMutationJob,
  isCurrent: () => boolean,
): Promise<WebPushMutationResult> {
  // Until the policy is trusted, registering default-derived filters could expose notifications
  // the account disabled.
  if (job.kind === "sync" && !job.notificationSettingsReady) {
    return { completed: false, activated: false, deferredRegistrations: [] };
  }
  const scope = registryScopeOf(job);
  const specs = job.kind === "sync" ? job.specs : [];
  const legacyIds = job.kind === "sync"
    ? [...new Set(specs.flatMap((spec) => [spec.id, ...(spec.replaces ?? [])]))]
      .map((logicalId) => scopePushSubscriptionId(logicalId, job.pubkey, job.domain))
    : job.legacyIds;
  const state = loadPushRegistrationState(scope, legacyIds);

  let pushSubscription:
    | {
      type: "web";
      endpoint: string;
      p256dh_key: string;
      auth_key: string;
    }
    | undefined;
  let browserSubscription: PushSubscription | undefined;

  if (job.kind === "sync") {
    const { registration, key, options } = job.prepared;
    const sub = await acquireWebPushSubscription(
      registration,
      key,
      options,
      job.gestureSubscription,
      isCurrent,
    );
    if (!sub || !isCurrent()) {
      return { completed: false, activated: false, deferredRegistrations: [] };
    }
    browserSubscription = sub;

    const json = sub.toJSON();
    pushSubscription = {
      type: "web",
      endpoint: sub.endpoint,
      p256dh_key: json.keys?.p256dh ?? "",
      auth_key: json.keys?.auth ?? "",
    };
  }

  const scopedSpecs = specs.map((spec) => ({
    ...spec,
    id: scopePushSubscriptionId(
      spec.id,
      job.pubkey,
      job.domain,
      job.installation,
    ),
  }));
  const replacementSpecs = new Map<string, PushSubscriptionSpec>();
  for (const logicalId of new Set(specs.flatMap((spec) => spec.replaces ?? []))) {
    replacementSpecs.set(
      logicalId,
      mergePushReplacementSpec(
        logicalId,
        specs.filter((spec) => spec.replaces?.includes(logicalId)),
      ),
    );
  }

  const result = await reconcilePushRegistrations({
    desired: scopedSpecs.map((spec, index) => {
      const registerSpecAs = async (source: PushSubscriptionSpec, id: string) => {
        if (!pushSubscription) throw new Error("Missing Web Push subscription");
        await job.client.registerSubscription({
          subscription_id: id,
          domain: job.domain,
          filter: source.filter,
          relays: source.relays,
          notification: source.notification,
          push_subscription: pushSubscription,
        });
      };
      const registerAs = (id: string) => registerSpecAs(spec, id);
      const fallbackLogicalId = spec.replaces?.[0];
      const fallbackSpec = fallbackLogicalId
        ? replacementSpecs.get(fallbackLogicalId)
        : undefined;
      const fallbackId = fallbackLogicalId
        ? scopePushSubscriptionId(
          fallbackLogicalId,
          job.pubkey,
          job.domain,
          job.installation,
        )
        : undefined;
      return {
        id: spec.id,
        replaces: [
          // Logical migrations (flat NIP-29 ids → per-relay ids) happen even after the migration latch.
          ...(spec.replaces ?? []).map((logicalId) => scopePushSubscriptionId(
            logicalId,
            job.pubkey,
            job.domain,
            job.installation,
          )),
          ...(!state.legacyMigrationComplete
            ? [specs[index]!.id, ...(spec.replaces ?? [])].map((logicalId) =>
              scopePushSubscriptionId(logicalId, job.pubkey, job.domain))
            : []),
        ],
        register: () => registerAs(spec.id),
        restoreReplaced: registerAs,
        ...(fallbackSpec && fallbackId ? {
          replacementGroup: {
            key: fallbackId,
            fallbackId,
            fallbackIds: [
              fallbackId,
              ...specs
                .filter((candidate) => candidate.replaces?.includes(fallbackSpec.id))
                .map((candidate) => scopePushSubscriptionId(
                  candidate.id,
                  job.pubkey,
                  job.domain,
                  job.installation,
                )),
              ...(!state.legacyMigrationComplete ? [scopePushSubscriptionId(
                fallbackSpec.id,
                job.pubkey,
                job.domain,
              )] : []),
            ],
            restoreFallback: (id: string) => registerSpecAs(fallbackSpec, id),
          },
        } : {}),
      };
    }),
    trackedIds: state.ids,
    deleteRegistration: (id) => job.client.deleteSubscription(id, job.domain),
    persistTrackedIds: (ids) => savePushRegistrationState(scope, {
      ids,
      legacyMigrationComplete: state.legacyMigrationComplete,
    }),
    isCurrent,
    allowPrune: job.kind === "delete" || job.authoritative,
    ...(job.kind === "sync" ? {
      canPruneId: (id: string) => {
        if (id.startsWith("armada-groups")) return job.groupPlaneReady;
        if (id.startsWith("armada-dm")) return job.dmPlaneReady;
        if (id.startsWith("armada-c2")) return job.concordPlaneReady;
        return false;
      },
    } : {}),
  });

  if (!result.completed) {
    return { completed: false, activated: false, deferredRegistrations: [] };
  }

  // An unreleasable stale record is a retry, not a reason to withhold activation (which would
  // mean no notifications at all). The error is raised below.
  const staleDeletionsRemain = result.failedDeletions.length > 0;

  // An incomplete pass can't prove old records stale, so don't complete migration (or latch
  // while a delete is outstanding).
  if ((job.kind === "sync" && !job.authoritative) || staleDeletionsRemain) {
    savePushRegistrationState(scope, {
      ids: result.trackedIds,
      legacyMigrationComplete: state.legacyMigrationComplete,
    });
  } else if (!state.legacyMigrationComplete) {
    completePushIdMigration(scope, result.trackedIds);
  } else {
    savePushRegistrationState(scope, {
      ids: result.trackedIds,
      legacyMigrationComplete: true,
    });
  }

  // Activate only after endpoint retirement is proven and this account's sealed config landed.
  let activated = false;
  if (job.kind === "sync" && browserSubscription && result.registeredAny) {
    const activationAllowed = await activateRegisteredWebPush({
      subscription: browserSubscription,
      registered: true,
      prepareConfig: () => job.prepareConfig(isCurrent),
      isCurrent,
    });
    if (!activationAllowed) {
      if (isCurrent()) {
        throw new Error(
          "The previous account's push endpoint could not be retired safely. Disable and re-enable notifications to retry.",
        );
      }
      return { completed: false, activated: false, deferredRegistrations: [] };
    }
    // Don't claim activation when nothing was attempted; a prior kill switch stays intentional.
    activated = true;
  }

  // Report the orphan last so the retry doesn't block notifications.
  if (staleDeletionsRemain) {
    throw new Error(
      `Failed to remove ${result.failedDeletions.length} stale push subscription(s)`,
    );
  }
  return {
    completed: true,
    activated,
    deferredRegistrations: result.deferredRegistrations ?? [],
  };
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
  const { config, updateConfig } = useAppContext();

  const unavailableReason = isNativeRuntime()
    ? "native-runtime" as const
    : isDesktop()
      // Electron exposes PushManager but has no push service behind it; report unavailable so
      // Settings offers the foreground notifier.
      ? "desktop" as const
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
  const prefs = config.pushPrefs;
  const preparedRef = useRef<PreparedPush | undefined>(undefined);
  /** Once account exit starts, this instance may never write again. */
  const exitingRef = useRef(false);
  /** Serialized so exit can clear strictly after pending config writes. */
  const swConfigTailRef = useRef<Promise<void>>(Promise.resolve());
  const queueSwConfig = useCallback((operation: () => Promise<void>) => {
    const work = swConfigTailRef.current.then(operation, operation);
    swConfigTailRef.current = work.catch(() => undefined);
    return work;
  }, []);

  const {
    specs,
    concord,
    dmKnownPeers,
    dmKnownConversationKeys,
    dmMutedPeers,
    dmLevels,
    dmSk,
    notificationSettingsReady,
    dmConfigReady,
    concordConfigReady,
    groupPlaneReady,
    dmPlaneReady,
    concordPlaneReady,
    watchSetReady,
  } = usePushWatchSet(prefs);
  const mediaPolicy = useMediaPolicyConfig();
  const notificationSettingsReadyRef = useRef(notificationSettingsReady);
  notificationSettingsReadyRef.current = notificationSettingsReady;

  /** The generation check is repeated inside the serialized write so stale keys never land last. */
  const writeCurrentSwConfig = useCallback(async (
    isCurrent: () => boolean = () => true,
  ) => {
    if (!user
      || !notificationSettingsReadyRef.current
      || exitingRef.current
      || !isCurrent()) {
      throw new Error("Push session changed before its config could be written");
    }

    // Mirror useKnownDmPeers' `mine`; bounded so a wedged IndexedDB can't block registration.
    let mineConversationKeys: string[] = [];
    try {
      const rows = await Promise.race([
        queryDm17Conversations(user.pubkey),
        new Promise<null>((resolve) => setTimeout(() => resolve(null), 3_000)),
      ]);
      if (rows) {
        const muted = new Set(dmMutedPeers);
        mineConversationKeys = rows
          .filter((row) => row.mine && row.peers.every((peer) => !muted.has(peer)))
          .map((row) => row.key);
      }
    } catch {
      // Store unavailable — the durable synced/pinned roster still applies.
    }
    if (!notificationSettingsReadyRef.current || exitingRef.current || !isCurrent()) {
      throw new Error("Push session changed before its config could be written");
    }

    await queueSwConfig(async () => {
      if (!notificationSettingsReadyRef.current || exitingRef.current || !isCurrent()) {
        throw new Error("Push session changed before its config could be written");
      }
      const written = await writeSwPushConfig({
        policy: prefs.dmRequests,
        self: user.pubkey,
        knownPeers: dmKnownPeers,
        knownConversations: [
          ...new Set([...dmKnownConversationKeys, ...mineConversationKeys]),
        ].sort(),
        mutedPeers: dmMutedPeers,
        dmReady: dmConfigReady,
        directMessages: prefs.directMessages,
        dmLevels,
        concordReady: concordConfigReady,
        concord: concord.flatMap((sub) =>
          sub.streams.map((s) => ({
            pk: s.pk,
            convKey: s.convKey,
            epoch: s.epoch,
            communityId: sub.communityId,
            channelId: sub.channelId,
            banned: sub.banned,
            mentionEveryoneAuthors: sub.mentionEveryoneAuthors,
            mentionOnly: sub.mentionOnly,
            muted: sub.muted,
          }))
        ),
        ...(dmSk ? { sk: dmSk } : {}),
        mediaPolicy,
      });
      if (!written) {
        throw new Error("The service worker notification policy could not be stored");
      }
    });
  }, [
    user,
    prefs.dmRequests,
    prefs.directMessages,
    dmKnownPeers,
    dmKnownConversationKeys,
    dmMutedPeers,
    dmConfigReady,
    dmLevels,
    concord,
    concordConfigReady,
    dmSk,
    mediaPolicy,
    queueSwConfig,
  ]);

  // Keep the worker's push config (DM policy, known set, nsec key, Concord stream keys) current;
  // cleared when push is off or logged out. Display data isn't sealed: the worker reads ArmadaDB at
  // push time (`pushRuntime.ts`).
  useEffect(() => {
    // Clear only when no session should hold a key. `enabled` is false during preparation, so
    // clearing on it wiped the worker config at every start.
    if (!supported || !user || !loadPushIntent()) {
      void queueSwConfig(clearSwPushConfig).catch(() => undefined);
      return;
    }
    if (exitingRef.current) return;
    // Still preparing: leave the existing config for the worker to use.
    if (!enabled) return;
    // Only this file's authorities matter; a group-list/DM-relay outage mustn't pin old keys.
    if (!notificationSettingsReady) return;
    let cancelled = false;
    writeCurrentSwConfig(() => !cancelled).catch((err) => {
      if (!cancelled && !exitingRef.current) {
        console.warn("[nostr-push] writing worker config failed:", err);
      }
    });
    return () => {
      cancelled = true;
    };
  }, [
    supported,
    user,
    enabled,
    notificationSettingsReady,
    queueSwConfig,
    writeCurrentSwConfig,
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

  const installation = useMemo(() => pushInstallationId(), []);
  const mutationRunnerRef = useRef<
    LatestSerialRunner<WebPushMutationJob, WebPushMutationResult> | null
  >(null);
  if (!mutationRunnerRef.current) {
    mutationRunnerRef.current = new LatestSerialRunner(mutateWebPushRegistrations);
  }
  const mutationRunner = mutationRunnerRef.current;

  // Supersede in-flight transactions as soon as policy authority is lost.
  useEffect(() => {
    if (!notificationSettingsReady) mutationRunner.invalidate();
  }, [notificationSettingsReady, mutationRunner]);

  // Prepare before showing enable: iOS requires PushManager.subscribe() directly from the tap,
  // and an RPC first would consume the activation.
  useEffect(() => {
    if (!supported || !client || !user || exitingRef.current) {
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
      // Always fetch the CURRENT key: a rotated VAPID pair would otherwise 403 forever. The cache is
      // only a fallback.
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

      // A VAPID rotation invalidates the old subscription; remove it now so the next tap can subscribe
      // first thing.
      const existing = await registration.pushManager.getSubscription();
      if (existing && !matchesWebPushServerKey(existing, key)) {
        await existing.unsubscribe().catch(() => false);
      }

      const prepared = { registration, key, options };
      const nextPermission = await pushPermission(prepared);
      const current = await registration.pushManager.getSubscription();
      if (cancelled || exitingRef.current) return;
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

  /** Incomplete snapshots are strictly additive. */
  const sync = useCallback(async (gestureSubscription?: PushSubscription) => {
    const prepared = preparedRef.current;
    if (!client || !user || !prepared) throw new Error("Push not ready");
    if (exitingRef.current || !notificationSettingsReady) return undefined;
    // Empty while not ready means "not loaded"; partial sets register but never prune.
    if (!watchSetReady
      && specs.length === 0
      && !groupPlaneReady
      && !dmPlaneReady
      && !concordPlaneReady) return undefined;
    if (exitingRef.current || !notificationSettingsReady) return undefined;
    return mutationRunner.run({
      kind: "sync",
      client,
      pubkey: user.pubkey,
      domain: pushDomain(),
      installation,
      prepared,
      specs,
      authoritative: watchSetReady,
      notificationSettingsReady,
      groupPlaneReady,
      dmPlaneReady,
      concordPlaneReady,
      prepareConfig: writeCurrentSwConfig,
      ...(gestureSubscription ? { gestureSubscription } : {}),
    });
  }, [
    client,
    user,
    notificationSettingsReady,
    groupPlaneReady,
    dmPlaneReady,
    concordPlaneReady,
    watchSetReady,
    mutationRunner,
    installation,
    specs,
    writeCurrentSwConfig,
  ]);

  const deleteGatewayRecords = useCallback(async () => {
    if (!client || !user) return;
    await mutationRunner.runExclusive({
      kind: "delete",
      client,
      pubkey: user.pubkey,
      domain: pushDomain(),
      installation,
      legacyIds: specs.map((spec) =>
        scopePushSubscriptionId(spec.id, user.pubkey, pushDomain())),
    });
  }, [client, user, mutationRunner, installation, specs]);

  // Switching and logout are too fast for render-driven cleanup, so register with the shared
  // pre-exit choke point.
  useEffect(() => {
    if (!user) return;
    return registerBeforeAccountExit(async () => {
      // Stop every writer synchronously before the first await.
      exitingRef.current = true;
      mutationRunner.invalidate();
      // Local safety first: the worker stays deny-by-default until the next account registers.
      await finishWebPushAccountExit({
        registration: preparedRef.current?.registration,
        clearConfig: () => queueSwConfig(clearSwPushConfig),
        deleteGatewayRecords,
      });
    });
  }, [user, mutationRunner, queueSwConfig, deleteGatewayRecords]);

  // The active-account marker is origin-global; fence stale tabs so they can't rewrite the shared
  // worker config. Only the initiating tab cleans up.
  useEffect(() => {
    if (!user) return;
    return installCrossTabAccountExit({
      pubkey: user.pubkey,
      fence: () => {
        exitingRef.current = true;
        mutationRunner.invalidate();
      },
    });
  }, [user, mutationRunner]);

  // Auto-(re)sync on load and watch-set changes (signature-guarded, with backoff).
  const syncSig = useMemo(
    () => JSON.stringify({
      domain: pushDomain(),
      pubkey: user?.pubkey,
      notificationSettingsReady,
      dmConfigReady,
      concordConfigReady,
      groupPlaneReady,
      dmPlaneReady,
      concordPlaneReady,
      authoritative: watchSetReady,
      specs,
    }),
    [
      user?.pubkey,
      notificationSettingsReady,
      dmConfigReady,
      concordConfigReady,
      groupPlaneReady,
      dmPlaneReady,
      concordPlaneReady,
      watchSetReady,
      specs,
    ],
  );
  const lastSynced = useRef<string | null>(null);
  const retry = useRef(0);
  const [nonce, setNonce] = useState(0);
  useEffect(() => {
    if (!supported || !ready || !client || !user) return;
    if (exitingRef.current) return;
    if (permission !== "granted") return;
    if (!loadPushIntent()) return;
    if (!notificationSettingsReady) return;
    if (!watchSetReady
      && specs.length === 0
      && !groupPlaneReady
      && !dmPlaneReady
      && !concordPlaneReady) return;
    if (lastSynced.current === syncSig) return;

    let cancelled = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    (async () => {
      try {
        const outcome = await sync();
        if (cancelled || !outcome?.completed) return;
        if (outcome.activated) setEnabled(true);
        if (outcome.deferredRegistrations.length > 0) {
          if (retry.current < 3) {
            const delay = 10_000 * 2 ** retry.current;
            retry.current += 1;
            timer = setTimeout(() => setNonce((n) => n + 1), delay);
          } else {
            setError("Some background notification watches could not be refreshed. Check your connection and retry.");
          }
          return;
        }
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
  }, [
    supported,
    ready,
    permission,
    client,
    user,
    notificationSettingsReady,
    groupPlaneReady,
    dmPlaneReady,
    concordPlaneReady,
    watchSetReady,
    specs.length,
    syncSig,
    sync,
    nonce,
  ]);

  // Re-register a rotated browser subscription (SW pushsubscriptionchange).
  useEffect(() => {
    if (!supported || !ready) return;
    const onMessage = (event: MessageEvent) => {
      if (exitingRef.current) return;
      if (event.data?.type !== "armada-push-changed") return;
      lastSynced.current = null;
      retry.current = 0;
      setNonce((n) => n + 1);
    };
    navigator.serviceWorker.addEventListener("message", onMessage);
    return () => navigator.serviceWorker.removeEventListener("message", onMessage);
  }, [supported, ready]);

  // iOS may rotate/revoke subscriptions while closed; recheck on visible/online.
  useEffect(() => {
    if (!supported || !ready) return;
    let cancelled = false;
    const recheck = async () => {
      if (exitingRef.current) return;
      if (document.visibilityState !== "visible") return;
      const prepared = preparedRef.current;
      if (!prepared) return;
      try {
        const [nextPermission, existing] = await Promise.all([
          pushPermission(prepared),
          prepared.registration.pushManager.getSubscription(),
        ]);
        if (cancelled || exitingRef.current) return;
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

  const enable = useCallback(async () => {
    const prepared = preparedRef.current;
    if (!supported || !ready || !user || !prepared || exitingRef.current) return;
    setBusy(true);
    setError(undefined);

    // subscribe() synchronously from the click: it's also the permission request, and works in iOS
    // Home-Screen apps where window.Notification is absent.
    const subscriptionPromise = prepared.registration.pushManager.subscribe(prepared.options);
    try {
      const subscription = await subscriptionPromise;
      setPermission("granted");
      savePushIntent(true);
      lastSynced.current = null;
      const outcome = await sync(subscription);
      if (outcome?.completed) {
        if (outcome.deferredRegistrations.length > 0) {
          // Existing records may be active even if a new id hit quota; keep it live and retry.
          if (outcome.activated) setEnabled(true);
          setError("Background notifications are enabled, but some watches still need to be refreshed.");
          setNonce((n) => n + 1);
          return;
        }
        lastSynced.current = syncSig;
        setEnabled(true);
      } else {
        // Endpoint exists but no default-derived watch was exposed; the sync effect activates it once
        // the notification document is authoritative.
        setEnabled(false);
        setError("Armada is still restoring your notification settings. Background notifications will finish enabling automatically.");
      }
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
      mutationRunner.invalidate();
      // Retry retirement even after a timed-out exit attempt, so the next enable can recover.
      await retireWebPushEndpoint(preparedRef.current?.registration);
      // Serialized after any in-flight sync; failed deletes stay for retry.
      await deleteGatewayRecords().catch((err) => {
        console.warn("[nostr-push] gateway cleanup failed:", err);
      });
      await queueSwConfig(clearSwPushConfig).catch(() => undefined);
      lastSynced.current = null;
      setEnabled(false);
    } finally {
      setBusy(false);
    }
  }, [deleteGatewayRecords, mutationRunner, queueSwConfig]);

  const setPrefs = useCallback(
    async (next: PushPrefs) => {
      savePushPrefs(next, user?.pubkey);
      updateConfig((current) => ({ ...current, pushPrefs: next }));
      // The specs recompute from `prefs`; force the sync effect to re-run.
      lastSynced.current = null;
      setNonce((n) => n + 1);
    },
    [updateConfig, user?.pubkey],
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
