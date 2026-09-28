import { App as CapacitorApp } from "@capacitor/app";

import { isNativeRuntime } from "@/lib/platform";
import { markDeepLinkNavigation } from "@/lib/deepLinkNav";
import { pathFromDeepLinkUrl } from "@/lib/deepLinkUrl";
import { takePendingPushOpen } from "@/lib/nativePush";

/**
 * Cold-launch deep-link resolution, resolved ONCE at startup. Notification and
 * App Link taps still load the SPA at `/`, and `getLaunchUrl()` resolves after
 * React mounts, so a late navigate loses to `HomeRedirect`'s default chain.
 * `HomeRedirect` waits for this instead; consuming once also avoids
 * re-navigating on later effects.
 */

let resolved = !isNativeRuntime();
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

if (isNativeRuntime()) {
  // Guard against a hung bridge pinning HomeRedirect and the native splash.
  // Generous: slow cold starts answer late, and the splash (8s cap) covers the wait.
  const timeout = setTimeout(() => settle(null), 4000);
  // An iOS push tap arrives via the notification delegate, not a launch URL;
  // read both together so both beat HomeRedirect's default.
  Promise.all([
    CapacitorApp.getLaunchUrl()
      .then((res) => pathFromDeepLinkUrl(res?.url))
      .catch(() => null),
    takePendingPushOpen().catch(() => null),
  ])
    .then(([urlPath, pushPath]) => {
      // Prefer the URL: more specific than a push tap (DM tier only).
      const path = urlPath ?? pushPath;
      if (!resolved) {
        clearTimeout(timeout);
        settle(path);
        return;
      }
      // Guard already fired: hand the path to late listeners
      // (useNotificationNavigation) — a second navigation beats none.
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

/** The cold-launch deep-link path, consumed once; null if none or already consumed. */
export function consumeColdLaunchDeepLink(): string | null {
  const p = deepLinkPath;
  deepLinkPath = null;
  // Lets SwipeReveal land on the destination without an entrance slide.
  if (p) markDeepLinkNavigation();
  return p;
}

/** Non-consuming read of the launch deep link (for warmup, e.g. pre-connecting the room's relay). */
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
 * Run `cb` if the launch URL resolves to a deep link after the guard timeout
 * already released HomeRedirect; applied once as an ordinary navigation.
 */
export function onLateColdLaunchDeepLink(cb: (path: string) => void): () => void {
  lateWaiters.add(cb);
  return () => lateWaiters.delete(cb);
}
