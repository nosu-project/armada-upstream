/**
 * The user's Web Push kill switch, enforced by the service worker itself.
 *
 * `disable()` in useNostrPush unsubscribes the browser subscription and
 * deletes the gateway registrations, but every one of those calls is
 * best-effort over the network — a flaky gateway, or a page killed mid-way,
 * leaves a live registration pushing at a device whose user said stop. This
 * flag is the local, durable statement of that intent, written FIRST so it
 * exists whatever else fails: the worker checks it per push, displays nothing
 * while it is set, and tears down its own subscription so the pushes stop at
 * the source (a dead endpoint answers 410 and the gateway drops the
 * registration — no relay cooperation needed).
 *
 * Lives in the same Cache Storage bucket as the DM config because a service
 * worker can't read localStorage. The path must match `PUSH_DISABLED_URL` in
 * `public/sw.js`.
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
    // Cache unavailable (private mode) — the caller's network teardown still
    // runs, which is all this install can do then.
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
