/**
 * Deep-link URL parsing shared by the warm (appUrlOpen) and cold
 * (getLaunchUrl) paths.
 *
 * Two URL shapes reach the app:
 *
 * 1. `armada://open<path>` - set on the PendingIntent of our own Android
 *    notifications (see NotificationRelayService.java).
 * 2. `https://armada.buzz/<path>` - Android App Links. The manifest declares a
 *    verified https intent filter for armada.buzz, so tapping an invite/share
 *    link (e.g. `https://armada.buzz/invite/naddr1...#secret`) opens the app
 *    directly instead of the browser.
 *
 * Both are converted to an in-app router path. Search AND hash must be
 *  preserved: group invites carry `?code=...` and Concord invites carry their
 * secret in the fragment.
 */

import { PUBLIC_WEB_ORIGIN } from "@/lib/shareOrigin";

/**
 * The host whose https links are ours to route.
 *
 * Taken from the same build-time origin share links are built on, because they
 * are the same fact: the App Links host in the Android manifest and the
 * `applinks:` entitlement is the public deployment, and an operator who
 * rebuilds with `VITE_PUBLIC_WEB_ORIGIN` changes all three together.
 */
const APP_LINK_HOST = ((): string | null => {
  try {
    return new URL(PUBLIC_WEB_ORIGIN).hostname.toLowerCase();
  } catch {
    return null;
  }
})();

/**
 * Whether a string is a router path and only a router path.
 *
 * A leading `//` (or `/\`, which the URL parser folds to the same thing) is a
 * PROTOCOL-RELATIVE URL, not a path: resolved against the page it names
 * another origin entirely. Nothing that reaches here is trusted to pick an
 * origin — an App Link's host is not checked by the OS beyond the manifest
 * filter, another app can fire an explicit intent carrying any https URL, and
 * a push gateway chooses the `url` field outright. React Router happens to
 * collapse the doubled slash before it navigates, so this is the guard rather
 * than the only one; it is here so the property is stated where the value
 * enters, not left resting on a normalization detail of a dependency.
 */
export function isRouterPath(path: string): boolean {
  return path.startsWith("/") && !/^\/[\\/]/.test(path);
}

/** Extract the in-app path from a deep-link URL, or null if it isn't one. */
export function pathFromDeepLinkUrl(url: string | undefined | null): string | null {
  if (!url) return null;

  // Notification taps: armada://open<path>
  const marker = "armada://open";
  if (url.startsWith(marker)) {
    const path = url.slice(marker.length);
    return isRouterPath(path) ? path : null;
  }

  // App Links: an https URL, which we route only when it names one of our own
  // hosts — the OS matched the manifest filter, but an explicit intent from
  // another app reaches the same handler with any host it likes.
  if (/^https:\/\//i.test(url)) {
    try {
      const u = new URL(url);
      if (u.hostname.toLowerCase() !== APP_LINK_HOST) return null;
      const path = u.pathname + u.search + u.hash;
      if (!isRouterPath(path)) return null;
      // A bare domain open ("/") is not a deep link; let the default
      // HomeRedirect flow pick the destination (avoids a self-navigation
      // loop at "/").
      return path === "/" ? null : path;
    } catch {
      return null;
    }
  }

  return null;
}
