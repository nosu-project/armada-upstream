/**
 * Module-level mark set the moment a deep link is applied as a navigation:
 * the warm `appUrlOpen` path, an iOS `pushOpened` tap, a cold launch consumed
 * by HomeRedirect, and the late cold-launch fallback.
 *
 * SwipeReveal reads it to skip its mount slide-in for these arrivals: a
 * notification tap should LAND on its destination — the native crest
 * gate/splash lifts onto a settled screen — not play one more transition
 * after the tap already sat through the navigation. The window is generous
 * because a cold destination mount can trail the navigation by a lazy-chunk
 * load; the cost of a stale mark is one skipped entrance animation on a
 * manual navigation made moments after a tap, which is cosmetic.
 */

const RECENT_MS = 5000;

let deepLinkNavAt = 0;

/** Record that a deep-link navigation was just applied. */
export function markDeepLinkNavigation(): void {
  deepLinkNavAt = Date.now();
}

/** Whether a deep-link navigation was applied within the last few seconds. */
export function isRecentDeepLinkNavigation(): boolean {
  return Date.now() - deepLinkNavAt < RECENT_MS;
}
