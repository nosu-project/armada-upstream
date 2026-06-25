/**
 * Cross-reload cache for decrypted Concord community images (logo / banner).
 *
 * Without this, every page load re-`fetch()`es the Blossom ciphertext and
 * re-runs AES-GCM for each icon/banner — the in-memory object-URL map is wiped
 * on reload. Here we persist the DECRYPTED plaintext bytes in the Cache Storage
 * API, keyed by the image's plaintext SHA-256 (`image.hash`) — content-
 * addressed, so the key is stable and tamper-evident (the decrypt path already
 * verifies the hash before storing). The plaintext lives only on the member's
 * own device, the same trust level as the rendered <img>.
 *
 * Cache Storage is used (not IndexedDB) because it stores `Response`/`Blob`
 * bodies efficiently and is available in the renderer + service-worker contexts.
 * Falls back to a no-op (network fetch + decrypt every time) where it's absent.
 */

const CACHE_NAME = "armada-community-images-v1";
/** A synthetic, content-addressed request URL for the Cache Storage key. */
const keyUrl = (hash: string) => `https://armada.cache/community-image/${hash}`;

function cacheAvailable(): boolean {
  return typeof caches !== "undefined";
}

/** Read decrypted image bytes from the persistent cache, or null on miss. */
export async function readCachedImage(hash: string, mime: string): Promise<Blob | null> {
  if (!hash || !cacheAvailable()) return null;
  try {
    const cache = await caches.open(CACHE_NAME);
    const res = await cache.match(keyUrl(hash));
    if (!res) return null;
    const buf = await res.arrayBuffer();
    return new Blob([buf], { type: mime });
  } catch {
    return null;
  }
}

/** Persist decrypted image bytes (fire-and-forget; best-effort). */
export async function writeCachedImage(hash: string, bytes: Uint8Array, mime: string): Promise<void> {
  if (!hash || !cacheAvailable()) return;
  try {
    const cache = await caches.open(CACHE_NAME);
    const body = bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer;
    await cache.put(keyUrl(hash), new Response(body, { headers: { "Content-Type": mime } }));
  } catch {
    // Best-effort: a cache write failure just means we re-decrypt next reload.
  }
}
