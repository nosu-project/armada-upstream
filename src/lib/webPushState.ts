/**
 * Cross-context state shared by the page and `public/sw.js` through Cache
 * Storage. It contains no plaintext or keys: only event ids for NIP-17
 * self-copies created on this device.
 */

const CACHE_NAME = "armada-push-state-v1";
const STATE_PREFIX = "/.armada-push-state/";
const OWN_EVENT_PREFIX = `${STATE_PREFIX}own/`;
const MAX_OWN_EVENTS = 512;

function cacheUrl(path: string): string {
  return new URL(path, window.location.origin).href;
}

async function openStateCache(): Promise<Cache | undefined> {
  if (typeof window === "undefined" || !("caches" in window)) return undefined;
  try {
    return await window.caches.open(CACHE_NAME);
  } catch {
    return undefined;
  }
}

/** Record a just-created NIP-17 self-copy before it is published. */
export async function markOwnWebPushEvent(eventId: string): Promise<void> {
  if (!eventId) return;
  const cache = await openStateCache();
  if (!cache) return;
  try {
    await cache.put(cacheUrl(`${OWN_EVENT_PREFIX}${encodeURIComponent(eventId)}`), new Response("1"));

    // Keep this bounded for long-running installs. Cache.keys() preserves the
    // cache's insertion order, so the oldest markers are discarded first.
    const prefix = cacheUrl(OWN_EVENT_PREFIX);
    const own = (await cache.keys()).filter((request) => request.url.startsWith(prefix));
    if (own.length > MAX_OWN_EVENTS) {
      await Promise.all(own.slice(0, own.length - MAX_OWN_EVENTS).map((request) => cache.delete(request)));
    }
  } catch {
    // A missing marker may cause one generic notification, but must not block a send.
  }
}
