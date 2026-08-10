import { App as CapacitorApp } from "@capacitor/app";

import { isNativeRuntime } from "@/hooks/useNativeNotifications";
import { pathFromDeepLinkUrl } from "@/lib/deepLinkUrl";
import { takePendingPushOpen } from "@/lib/nativePush";

/**
 * Cold-launch deep-link resolution, resolved ONCE at startup.
 *
 * A notification tap launches the process with an `armada://open<path>` URL on
 * Android and through the notification delegate on iOS (`nativePush.ts`), and
 * an App Link tap with an `https://armada.buzz/<path>` URL, but
 * Capacitor still loads the SPA at its root (`/`), and `App.getLaunchUrl()` is
 * async — it resolves a beat AFTER React mounts. By then the router's
 * `HomeRedirect` has already sent `/` to the default server, `ServerPage` has
 * auto-opened the default group, and a late `navigate(deepLink)` ends up
 * fighting (and losing to) that chain. The symptom: a tapped notification opens
 * the default server/channel instead of the room it was about.
 *
 * Fix: resolve the launch URL ONCE here, and let `HomeRedirect` WAIT for it
 * before choosing a destination — so the deep link is the first real navigation,
 * never an override applied after the default already won.
 *
 * `getLaunchUrl()` returns the same value for the whole process, so resolving it
 * exactly once (and consuming the path exactly once) also prevents it from
 * re-navigating on later effect runs (which would trap the user in the room).
 */

let resolved = !isNativeRuntime(); // web: nothing to wait for
let deepLinkPath: string | null = null;
/** The launch deep link, retained past consumption (for non-navigation uses). */
let launchDeepLinkPath: string | null = null;
const waiters = new Set<() => void>();
const lateWaiters = new Set<(path: string) => void>();

function settle(path: string | null): void {
  deepLinkPath = path;
  launchDeepLinkPath = path;
  resolved = true;
  for (const w of waiters) w();
  waiters.clear();
}

// Kick off the single launch-URL read at module load (before React mounts).
if (isNativeRuntime()) {
  // Guard so a hung bridge can't pin HomeRedirect forever.
  const timeout = setTimeout(() => settle(null), 1500);
  // Two cold sources, read together. An iOS push tap is delivered to the
  // notification delegate rather than as a URL open, so it produces no launch
  // URL — but it is the same kind of fact, arrives at the same moment, and must
  // beat HomeRedirect's default in the same way. Reading both here is what
  // keeps that one race in one place; a tap resolved separately would navigate
  // AFTER the default had already won, which is a tap that "didn't work".
  Promise.all([
    CapacitorApp.getLaunchUrl()
      .then((res) => pathFromDeepLinkUrl(res?.url))
      .catch(() => null),
    takePendingPushOpen().catch(() => null),
  ])
    .then(([urlPath, pushPath]) => {
      // Only one of them can be why the process started; prefer the URL, which
      // is the more specific of the two (a push tap knows only the DM tier).
      const path = urlPath ?? pushPath;
      if (!resolved) {
        clearTimeout(timeout);
        settle(path);
        return;
      }
      // The guard already fired and HomeRedirect committed to the default
      // route — this launch URL used to be silently dropped here, which is a
      // notification tap that "didn't work". Hand it to the late listeners
      // (useNotificationNavigation) instead: a second navigation moments
      // after boot beats none.
      if (path) {
        launchDeepLinkPath = path;
        for (const w of lateWaiters) w(path);
      }
    })
    .catch(() => {
      clearTimeout(timeout);
      settle(null);
    });
}

/** True until the launch URL has been read — HomeRedirect holds its redirect. */
export function coldLaunchPending(): boolean {
  return !resolved;
}

/**
 * The cold-launch deep-link path (consumed once). Returns null if the launch
 * wasn't a deep link, or after it's already been consumed.
 */
export function consumeColdLaunchDeepLink(): string | null {
  const p = deepLinkPath;
  deepLinkPath = null;
  return p;
}

/**
 * Non-consuming read of the cold-launch deep-link path, retained even after
 * HomeRedirect consumes it for navigation. Used by the warmup path
 * (pre-connecting the target room's relay). Null before resolution / when the
 * launch wasn't a deep link.
 */
export function peekColdLaunchDeepLink(): string | null {
  return launchDeepLinkPath;
}

/** Run `cb` once the launch URL resolves (immediately if already resolved). */
export function onColdLaunchResolved(cb: () => void): () => void {
  if (resolved) {
    cb();
    return () => undefined;
  }
  waiters.add(cb);
  return () => waiters.delete(cb);
}

/**
 * Run `cb` if the launch URL resolves to a deep link AFTER the 1.5s guard has
 * already released HomeRedirect (which then owns no navigation any more —
 * it's unmounted). The subscriber applies the path as an ordinary in-router
 * navigation, exactly once per process (the read itself is once-only).
 */
export function onLateColdLaunchDeepLink(cb: (path: string) => void): () => void {
  lateWaiters.add(cb);
  return () => lateWaiters.delete(cb);
}
