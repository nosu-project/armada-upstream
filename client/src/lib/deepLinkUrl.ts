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

/** Extract the in-app path from a deep-link URL, or null if it isn't one. */
export function pathFromDeepLinkUrl(url: string | undefined | null): string | null {
  if (!url) return null;

  // Notification taps: armada://open<path>
  const marker = "armada://open";
  if (url.startsWith(marker)) {
    const path = url.slice(marker.length);
    return path.startsWith("/") ? path : null;
  }

  // App Links: any https URL the OS hands us matched the manifest's host
  // filter, so forward its path verbatim to the router.
  if (/^https:\/\//i.test(url)) {
    try {
      const u = new URL(url);
      const path = u.pathname + u.search + u.hash;
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
