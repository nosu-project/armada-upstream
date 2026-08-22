import { sha256 } from "@noble/hashes/sha2.js";
import { bytesToHex } from "@noble/hashes/utils.js";

import { clearPushDisabledFlag, writePushDisabledFlag } from "@/lib/swPushDisabled";

/** Survives reload/final purge so the next account can prove endpoint safety. */
export const WEB_PUSH_RETIREMENT_KEY = "armada:web-push-retirement:v1";

export interface WebPushRetirementProof {
  /** Hash only: a push endpoint URL is a bearer capability and is never stored. */
  endpointFingerprint?: string;
  /** `PushSubscription.unsubscribe()` explicitly returned true, or none existed. */
  unsubscribeSucceeded: boolean;
}

/** Stable, non-reversible comparison token for a browser endpoint. */
export function webPushEndpointFingerprint(endpoint: string): string {
  return bytesToHex(sha256(new TextEncoder().encode(endpoint)));
}

export function loadWebPushRetirementProof(): WebPushRetirementProof | undefined {
  try {
    const raw = localStorage.getItem(WEB_PUSH_RETIREMENT_KEY);
    if (!raw) return undefined;
    const parsed: unknown = JSON.parse(raw);
    if (!parsed || typeof parsed !== "object") return undefined;
    const proof = parsed as Partial<WebPushRetirementProof>;
    if (typeof proof.unsubscribeSucceeded !== "boolean") return undefined;
    return {
      unsubscribeSucceeded: proof.unsubscribeSucceeded,
      ...(typeof proof.endpointFingerprint === "string"
        ? { endpointFingerprint: proof.endpointFingerprint }
        : {}),
    };
  } catch {
    return undefined;
  }
}

function saveWebPushRetirementProof(proof: WebPushRetirementProof): void {
  try {
    localStorage.setItem(WEB_PUSH_RETIREMENT_KEY, JSON.stringify(proof));
  } catch {
    // The durable worker kill switch remains the conservative fallback.
  }
}

function clearWebPushRetirementProof(): void {
  try {
    localStorage.removeItem(WEB_PUSH_RETIREMENT_KEY);
  } catch {
    // A stale success proof is harmless: the next activation re-validates it.
  }
}

/** Whether an existing browser subscription was made against `vapidKey`. */
export function matchesWebPushServerKey(
  subscription: PushSubscription,
  vapidKey: ArrayBuffer,
): boolean {
  const current = subscription.options?.applicationServerKey;
  if (!current) return true;
  const a = new Uint8Array(current);
  const b = new Uint8Array(vapidKey);
  if (a.length !== b.length) return false;
  return a.every((byte, index) => byte === b[index]);
}

/**
 * Return this install's current endpoint, repairing a VAPID rotation or absent
 * subscription. If the owning mutation becomes stale while subscribe is in
 * flight, retire the just-created endpoint instead of resurrecting it after an
 * account exit.
 */
export async function acquireWebPushSubscription(
  registration: ServiceWorkerRegistration,
  vapidKey: ArrayBuffer,
  options: PushSubscriptionOptionsInit,
  gestureSubscription?: PushSubscription,
  isCurrent: () => boolean = () => true,
): Promise<PushSubscription | undefined> {
  let subscription = gestureSubscription
    ?? await registration.pushManager.getSubscription();
  if (!isCurrent()) return undefined;

  if (subscription && !matchesWebPushServerKey(subscription, vapidKey)) {
    await subscription.unsubscribe().catch(() => false);
    subscription = null;
    if (!isCurrent()) return undefined;
  }

  if (!subscription) {
    subscription = await registration.pushManager.subscribe(options);
    if (!isCurrent()) {
      await subscription.unsubscribe().catch(() => false);
      return undefined;
    }
  }
  return subscription;
}

/**
 * Put the worker in deny-by-default mode and retire the current browser
 * endpoint. This is local safety and therefore runs before any gateway RPC.
 * It applies to account switches as well as final logout: an old account's
 * timed-out DELETE must not keep delivering plaintext group notifications in
 * the next account's page.
 */
export async function retireWebPushEndpoint(
  registration?: ServiceWorkerRegistration,
): Promise<void> {
  await writePushDisabledFlag();
  // Persist uncertainty before the first browser await. An account-switch
  // timeout/reload can terminate this function at any later line.
  saveWebPushRetirementProof({ unsubscribeSucceeded: false });
  try {
    const resolved = registration ?? await navigator.serviceWorker.ready;
    const subscription = await resolved.pushManager.getSubscription();
    if (!subscription) {
      saveWebPushRetirementProof({ unsubscribeSucceeded: true });
      return;
    }
    const endpointFingerprint = webPushEndpointFingerprint(subscription.endpoint);
    saveWebPushRetirementProof({ endpointFingerprint, unsubscribeSucceeded: false });
    const unsubscribeSucceeded = await subscription.unsubscribe();
    saveWebPushRetirementProof({ endpointFingerprint, unsubscribeSucceeded });
  } catch {
    // The durable worker flag remains the local backstop when PushManager is
    // unavailable or the push service rejects endpoint retirement.
  } finally {
    await writePushDisabledFlag();
  }
}

/** Ordered account-exit teardown, exported for lifecycle regression tests. */
export async function finishWebPushAccountExit(options: {
  registration?: ServiceWorkerRegistration;
  clearConfig: () => Promise<void>;
  deleteGatewayRecords: () => Promise<void>;
}): Promise<void> {
  await retireWebPushEndpoint(options.registration);
  await options.clearConfig().catch(() => undefined);
  try {
    await options.deleteGatewayRecords();
  } finally {
    // A stale mutation may have been clearing the flag as exit began. This is
    // the last local write after the serialized gateway lane has settled.
    await writePushDisabledFlag();
  }
}

/**
 * Lift the account-exit kill switch after one current-account registration.
 *
 * Gateway prune authority is deliberately unrelated: a partial watch snapshot
 * may register useful records and activate them. Endpoint safety instead comes
 * from proving the outgoing endpoint was retired, or that the current endpoint
 * differs. The current account's sealed config is awaited before the flag is
 * cleared, so no push can slip through a generic/no-policy window.
 */
export async function activateRegisteredWebPush(options: {
  subscription: PushSubscription;
  registered: boolean;
  prepareConfig: () => Promise<void>;
  isCurrent: () => boolean;
}): Promise<boolean> {
  if (!options.registered || !options.isCurrent()) return options.isCurrent();
  const proof = loadWebPushRetirementProof();
  const currentFingerprint = webPushEndpointFingerprint(options.subscription.endpoint);
  const endpointSafe = proof === undefined
    || proof.unsubscribeSucceeded
    || (proof.endpointFingerprint !== undefined
      && proof.endpointFingerprint !== currentFingerprint);
  if (!endpointSafe) return false;

  await options.prepareConfig();
  if (!options.isCurrent()) return false;
  await clearPushDisabledFlag();
  if (options.isCurrent()) {
    clearWebPushRetirementProof();
    return true;
  }

  // Exit began while Cache Storage was deleting the flag. Restore it so the
  // stale generation cannot win the last local write.
  await writePushDisabledFlag();
  return false;
}
