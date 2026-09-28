/**
 * The Web Push kill switch, enforced by the service worker: written FIRST on
 * disable (the network teardown is best-effort), the worker then shows nothing
 * and unsubscribes itself so the gateway gets 410s. Path must match
 * `PUSH_DISABLED_URL` in `public/sw.js`.
 */

const PUSH_STATE_CACHE = "armada-push-state-v1";
const DISABLED_PATH = "/.armada-push-state/disabled";

function disabledUrl(): string {
  return new URL(DISABLED_PATH, location.origin).href;
}

/** Assert "push is off" where the worker can read it. */
export async function writePushDisabledFlag(): Promise<void> {
  if (typeof caches === "undefined" || typeof location === "undefined") return;
  try {
    const cache = await caches.open(PUSH_STATE_CACHE);
    await cache.put(disabledUrl(), new Response("1"));
  } catch {
    // Cache unavailable (private mode); the network teardown still runs.
  }
}

/** Lift the kill switch; called on the enable path before pushes can resume. */
export async function clearPushDisabledFlag(): Promise<void> {
  if (typeof caches === "undefined" || typeof location === "undefined") return;
  try {
    const cache = await caches.open(PUSH_STATE_CACHE);
    await cache.delete(disabledUrl());
  } catch {
    // ignore
  }
}
