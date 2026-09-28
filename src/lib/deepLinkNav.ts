/**
 * Set when a deep link is applied as a navigation, so SwipeReveal skips its
 * slide-in and a notification tap lands on a settled screen. Generous window
 * (cold mounts trail lazy chunks); a stale mark only skips one animation.
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
