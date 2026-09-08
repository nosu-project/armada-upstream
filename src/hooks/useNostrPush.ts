import { useNostr } from "@nostrify/react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import { useAppContext } from "@/hooks/useAppContext";
import { useCurrentUser } from "@/hooks/useCurrentUser";
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
 * useNostrPush
 *
 * Web Push against a content-blind nostr-push gateway (NIP-PUSH), the
 * replacement for the deprecated push endpoint the client used to reach on the
 * relay itself. Unlike that legacy gateway — which is embedded in a relay and
 * sees every stored event — this server only matches the raw filters we
 * register and sends a static wake-up;
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
  /** Legacy logical ids known by the outgoing snapshot. */
  legacyIds: string[];
}

type WebPushMutationJob = WebPushSyncJob | WebPushDeleteJob;

export interface WebPushMutationResult {
  /** False when a newer generation superseded this mutation. */
  completed: boolean;
  /** The worker kill switch was safely lifted for this endpoint. */
  activated: boolean;
  /** Additive records that did not fit/reach the gateway and need a retry. */
  deferredRegistrations: string[];
}

function registryScopeOf(job: WebPushMutationJob): PushRegistryScope {
  return {
    pubkey: job.pubkey,
    domain: job.domain,
    installation: job.installation,
  };
}

/** One serialized, generation-aware gateway reconciliation. */
export async function mutateWebPushRegistrations(
  job: WebPushMutationJob,
  isCurrent: () => boolean,
): Promise<WebPushMutationResult> {
  // A partial watch set may be additive, but its policy is not. Until the
  // NIP-78/settings authorities represented in the sealed worker config are
  // trusted, registering default-derived filters and lifting the account-exit
  // kill switch could expose notifications the account explicitly disabled.
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
          // Logical filter migrations (notably flat NIP-29 ids → exact
          // per-relay ids) happen even after the web-install migration latch.
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

  // A stale record the gateway refused to release is a RETRY, not a reason to
  // withhold activation. Everything this pass registered is correct, and
  // endpoint safety is proven separately (`activateRegisteredWebPush`), so
  // returning here would leave a correct endpoint behind the durable
  // account-exit kill switch with no sealed policy — silently no
  // notifications at all until that one record becomes deletable. The error
  // is still raised below, after the useful work has landed.
  const staleDeletionsRemain = result.failedDeletions.length > 0;

  // An incomplete cold-load pass may add installation-scoped records, but it
  // cannot prove that the legacy/shared or previously tracked records are
  // stale. Completing migration would forget the very ids a later full pass
  // needs to delete — and so would latching it while a delete this pass
  // attempted is still outstanding.
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

  // Account exit leaves a durable deny-by-default flag behind. A successful
  // partial registration may activate useful current-account watches, but only
  // after endpoint retirement is proven and this account's sealed config has
  // landed. Full watch authority remains solely the prune decision above.
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
    // Avoid claiming activation merely because no registration was attempted:
    // a prior account-exit kill switch remains intentional in that case.
    activated = true;
  }

  // Report the orphan last, so the caller's bounded retry keeps trying to
  // release it without that retry being the thing standing between a correct
  // endpoint and any notification at all.
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
      // Electron exposes window.PushManager and registers a service worker, so
      // the plain capability probe reports Web Push "supported" — but its
      // Chromium has no push service behind that API, so getVapidKey/subscribe
      // can only fail (misleadingly, as "check your connection"). Report it
      // unavailable so Settings offers the foreground notifier — the only
      // notifier the desktop shell has — instead of a toggle that never works.
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
  /** Once account exit starts, this mounted instance may never write again. */
  const exitingRef = useRef(false);
  /** Serialize and expose config writes so exit can clear strictly after them. */
  const swConfigTailRef = useRef<Promise<void>>(Promise.resolve());
  const queueSwConfig = useCallback((operation: () => Promise<void>) => {
    const work = swConfigTailRef.current.then(operation, operation);
    swConfigTailRef.current = work.catch(() => undefined);
    return work;
  }, []);

  // The watch set — the same one the Android background service uses, and the
  // one the APNs controller registers (`usePushWatchSet`).
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
  const notificationSettingsReadyRef = useRef(notificationSettingsReady);
  notificationSettingsReadyRef.current = notificationSettingsReady;

  /**
   * Seal one current-account config snapshot. The generation check is repeated
   * before and inside the serialized write so neither a newer watch snapshot
   * nor account exit can let stale keys land last.
   */
  const writeCurrentSwConfig = useCallback(async (
    isCurrent: () => boolean = () => true,
  ) => {
    if (!user
      || !notificationSettingsReadyRef.current
      || exitingRef.current
      || !isCurrent()) {
      throw new Error("Push session changed before its config could be written");
    }

    // Mirror useKnownDmPeers' `mine` dimension. This local-store enhancement
    // is bounded: a wedged IndexedDB must not indefinitely hold the endpoint's
    // kill switch or prevent otherwise-valid current-account registrations.
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
    queueSwConfig,
  ]);

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
    // Clear only in states that MEAN no session should hold a key: logged out,
    // unsupported runtime, or the user's push intent turned off. `enabled` is
    // false during every session's PREPARATION (and stays false when the
    // gateway RPC fails), so clearing on it deleted the worker's decrypt
    // config at each app start — a session that died before preparing left
    // every later push degraded to the generic wake-up until a fully
    // successful load happened to rewrite it.
    if (!supported || !user || !loadPushIntent()) {
      void queueSwConfig(clearSwPushConfig).catch(() => undefined);
      return;
    }
    if (exitingRef.current) return;
    // Still preparing: leave the existing config for the worker to use.
    if (!enabled) return;
    // Only the authorities represented in this file matter. A NIP-29 group
    // list or DM-relay outage may block gateway pruning, but must not pin old
    // decrypt keys/policy when the DM roster and Concord folds are complete.
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

  const installation = useMemo(() => pushInstallationId(), []);
  const mutationRunnerRef = useRef<
    LatestSerialRunner<WebPushMutationJob, WebPushMutationResult> | null
  >(null);
  if (!mutationRunnerRef.current) {
    mutationRunnerRef.current = new LatestSerialRunner(mutateWebPushRegistrations);
  }
  const mutationRunner = mutationRunnerRef.current;

  // Supersede a registration/config transaction as soon as policy authority
  // is lost. `writeCurrentSwConfig` also reads the ref immediately
  // before its serialized write, closing the async gap before this effect.
  useEffect(() => {
    if (!notificationSettingsReady) mutationRunner.invalidate();
  }, [notificationSettingsReady, mutationRunner]);

  // Prepare the service worker and public VAPID key before showing an enable
  // action. PushManager.subscribe() has to run directly from the user's tap on
  // iOS; doing this RPC first would consume that transient activation.
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

  /** Queue one snapshot; incomplete snapshots are strictly additive. */
  const sync = useCallback(async (gestureSubscription?: PushSubscription) => {
    const prepared = preparedRef.current;
    if (!client || !user || !prepared) throw new Error("Push not ready");
    if (exitingRef.current || !notificationSettingsReady) return undefined;
    // Empty while false is "not loaded", never an instruction to replace or
    // prune. A non-empty partial set is still useful: register those records
    // now, and retain every prior id until readiness makes deletion safe.
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

  /** Remove this account/install's known records in the same serial lane. */
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

  // Account switching hard-reloads, and final logout purges the registry. Both
  // happen too quickly for a render-driven cleanup, so register the outgoing
  // signer/session with the shared pre-exit choke point.
  useEffect(() => {
    if (!user) return;
    return registerBeforeAccountExit(async () => {
      // This hook remains mounted while the account switcher waits for its
      // bounded cleanup. Stop every render-driven writer synchronously before
      // the first await, and supersede a queued/running registration snapshot.
      exitingRef.current = true;
      mutationRunner.invalidate();
      // Local safety comes before the bounded network cleanup on EVERY exit.
      // A failed old-account DELETE can then target only a retired endpoint,
      // and the worker stays deny-by-default until the next account finishes
      // an authoritative registration.
      await finishWebPushAccountExit({
        registration: preparedRef.current?.registration,
        clearConfig: () => queueSwConfig(clearSwPushConfig),
        deleteGatewayRecords,
      });
    });
  }, [user, mutationRunner, queueSwConfig, deleteGatewayRecords]);

  // The active-account marker is origin-global. A switch in another tab does
  // not reload this document, so without this fence its old signer can rewrite
  // the shared worker config and clear the shared kill switch behind the new
  // account. The initiating tab is the sole cleanup leader; followers only
  // fence and reload, never tear down the incoming account's shared endpoint.
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

  // Auto-(re)sync on every load and whenever the watch set changes: opt-out, so
  // as long as the user intends push, permission is granted, and there is
  // something to watch, keep the server's subscriptions current. Guarded by a
  // signature so an unrelated re-render doesn't re-PUT. Transient failures retry
  // with backoff.
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

  // A rotated browser subscription (SW pushsubscriptionchange → message) must
  // be re-registered with the server.
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

  // iOS can rotate or revoke a subscription while Armada is closed. Recheck
  // whenever the app becomes visible/online; granted intent with no current
  // subscription is repaired by the auto-sync effect above.
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

  // ── Public actions ─────────────────────────────────────────────────────────

  const enable = useCallback(async () => {
    const prepared = preparedRef.current;
    if (!supported || !ready || !user || !prepared || exitingRef.current) return;
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
      const outcome = await sync(subscription);
      if (outcome?.completed) {
        if (outcome.deferredRegistrations.length > 0) {
          // Stable existing records may already be active even though a new
          // additive id hit quota. Keep that useful endpoint live and schedule
          // the same bounded retry path without claiming the snapshot synced.
          if (outcome.activated) setEnabled(true);
          setError("Background notifications are enabled, but some watches still need to be refreshed.");
          setNonce((n) => n + 1);
          return;
        }
        lastSynced.current = syncSig;
        setEnabled(true);
      } else {
        // The endpoint exists (the gesture cannot be replayed automatically on
        // iOS), but no default-derived gateway watch was exposed. Once the
        // notification document becomes authoritative, the standing sync
        // effect registers it and activates this endpoint.
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
      // Retry endpoint retirement even when an earlier account-exit attempt
      // persisted only `{ success:false }` before timing out. A successful
      // explicit disable upgrades that durable proof, so the next enable can
      // recover instead of remaining permanently deny-by-default.
      await retireWebPushEndpoint(preparedRef.current?.registration);
      // Serialize after any in-flight sync and keep failed deletes in the
      // scoped registry for a later retry.
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
