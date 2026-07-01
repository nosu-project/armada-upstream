import { App as CapacitorApp } from "@capacitor/app";

import { isNativeRuntime } from "@/hooks/useNativeNotifications";

/**
 * Cold-launch deep-link resolution, resolved ONCE at startup.
 *
 * A notification tap launches the process with an `armada://open<path>` URL, but
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

/** Extract the in-app path from an `armada://open<path>` URL, or null. */
function pathFromOpenUrl(url: string | undefined | null): string | null {
  if (!url) return null;
  const marker = "armada://open";
  if (!url.startsWith(marker)) return null;
  const path = url.slice(marker.length);
  return path.startsWith("/") ? path : null;
}

let resolved = !isNativeRuntime(); // web: nothing to wait for
let deepLinkPath: string | null = null;
/** The launch deep link, retained past consumption (for non-navigation uses). */
let launchDeepLinkPath: string | null = null;
const waiters = new Set<() => void>();

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
  CapacitorApp.getLaunchUrl()
    .then((res) => {
      clearTimeout(timeout);
      settle(pathFromOpenUrl(res?.url));
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
