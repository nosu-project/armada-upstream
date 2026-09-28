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
 * This install's endpoint, repairing VAPID rotation or absence. If the owner
 * goes stale mid-subscribe, retire the new endpoint rather than resurrect it.
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
 * Deny-by-default the worker and retire the browser endpoint, before any
 * gateway RPC — on account switches too, so an old account's timed-out DELETE
 * can't keep notifying in the next account's page.
 */
export async function retireWebPushEndpoint(
  registration?: ServiceWorkerRegistration,
): Promise<void> {
  await writePushDisabledFlag();
  // Persist uncertainty before the first await; a switch may kill us any time after.
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
    // The durable worker flag remains the backstop.
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
    // Last local write, after the gateway lane settles; beats a stale flag-clear.
    await writePushDisabledFlag();
  }
}

/**
 * Lift the exit kill switch after a current-account registration, only when the
 * outgoing endpoint is proven retired (or differs), and only after the sealed
 * config is written, so no push slips through a no-policy window.
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

  // Exit began while the flag was being deleted: restore it.
  await writePushDisabledFlag();
  return false;
}
