/**
 * Deep-link URL parsing for the warm (appUrlOpen) and cold (getLaunchUrl) paths:
 * `armada://open<path>` (our notifications) and `https://<app host>/<path>`
 * (App Links). Search AND hash are preserved (invite codes and Concord secrets).
 */

import { PUBLIC_WEB_ORIGIN } from "@/lib/shareOrigin";

/** The App Links host, from the same build-time origin as share links (`PUBLIC_WEB_ORIGIN`). */
const APP_LINK_HOST = ((): string | null => {
  try {
    return new URL(PUBLIC_WEB_ORIGIN).hostname.toLowerCase();
  } catch {
    return null;
  }
})();

/**
 * Whether a string is purely a router path. A leading `//` or `/\` is a
 * protocol-relative URL naming another origin; inputs are untrusted (explicit
 * intents, push gateways), so guard here rather than rely on React Router.
 */
export function isRouterPath(path: string): boolean {
  return path.startsWith("/") && !/^\/[\\/]/.test(path);
}

/** Extract the in-app path from a deep-link URL, or null if it isn't one. */
export function pathFromDeepLinkUrl(url: string | undefined | null): string | null {
  if (!url) return null;

  const marker = "armada://open";
  if (url.startsWith(marker)) {
    const path = url.slice(marker.length);
    return isRouterPath(path) ? path : null;
  }

  // Route only our own host: explicit intents from other apps can carry any host.
  if (/^https:\/\//i.test(url)) {
    try {
      const u = new URL(url);
      if (u.hostname.toLowerCase() !== APP_LINK_HOST) return null;
      const path = u.pathname + u.search + u.hash;
      if (!isRouterPath(path)) return null;
      // Bare "/" isn't a deep link; let HomeRedirect choose (avoids a self-nav loop).
      return path === "/" ? null : path;
    } catch {
      return null;
    }
  }

  return null;
}
