import { useEffect, useState } from "react";

import { decryptImageToObjectURL } from "@/concord-v1/lib/communityImage";

import type { CommunityImage } from "@/concord-v1/lib/types";

/**
 * Resolve an encrypted Concord {@link CommunityImage} (logo / banner) to a
 * displayable object URL, fetching + AES-GCM-decrypting the Blossom ciphertext.
 *
 * Results are cached per (url, key, nonce) so the same image rendered in the
 * rail, header, and settings dialog decrypts once. Object URLs are intentionally
 * never revoked (a visible <img> may still reference one, and the same blob
 * recurs across re-renders); the cache is bounded so it can't grow unbounded.
 */

const MAX_CACHED = 128;
/** In-flight / past decrypts, keyed by (url, key, nonce). */
const cache = new Map<string, Promise<string>>();
/**
 * RESOLVED object URLs, keyed the same way. Distinct from `cache` (which holds
 * promises) so a remount can seed `useState` SYNCHRONOUSLY from an already-
 * decrypted URL — no `null` first frame, hence no avatar flicker. Without this,
 * the hook started at `null` and only set the URL after the (async) promise
 * resolved, blanking the icon to its fallback for a frame on every reload/remount
 * even when the bytes were already on disk (Cache Storage) and the promise was
 * already settled.
 */
const resolved = new Map<string, string>();

function cacheKey(image: CommunityImage): string {
  return `${image.url}\n${image.key}\n${image.nonce}`;
}

/** Returns the decrypted object URL, or null while loading / on failure. */
export function useDecryptedCommunityImage(image: CommunityImage | undefined): string | null {
  // Key the effect on primitives only — callers often pass a fresh
  // CommunityImage object each render, so depending on the object identity
  // would re-run the effect (and setState) every render.
  const url = image?.url;
  const key = image?.key;
  const nonce = image?.nonce;
  // Seed synchronously from the resolved-URL cache so a remount/reload with an
  // already-decrypted image paints the icon on the FIRST frame (no flicker).
  const [src, setSrc] = useState<string | null>(() =>
    image ? resolved.get(cacheKey(image)) ?? null : null,
  );

  useEffect(() => {
    if (!image || !url || !key || !nonce) {
      setSrc(null);
      return;
    }
    const ck = cacheKey(image);

    // Already resolved (warm cache): keep showing it, don't blank to null. This
    // is the common path on reload — the bytes are in Cache Storage and the URL
    // was minted earlier this session — and is exactly the frame that flickered.
    const ready = resolved.get(ck);
    if (ready) {
      setSrc(ready);
      return;
    }

    let cancelled = false;
    let promise = cache.get(ck);
    if (!promise) {
      promise = decryptImageToObjectURL(image);
      cache.set(ck, promise);
      promise
        .then((u) => {
          resolved.set(ck, u);
          if (resolved.size > MAX_CACHED) {
            const oldest = resolved.keys().next().value;
            if (oldest !== undefined && oldest !== ck) resolved.delete(oldest);
          }
        })
        .catch(() => {
          if (cache.get(ck) === promise) cache.delete(ck);
        });
      if (cache.size > MAX_CACHED) {
        const oldest = cache.keys().next().value;
        if (oldest !== undefined && oldest !== ck) cache.delete(oldest);
      }
    }
    // Not yet resolved this session: show the fallback until the decrypt lands.
    // (The warm-cache case returned above, so this only fires on a genuine
    // first decrypt or when switching to a different image.)
    setSrc(null);
    promise.then((u) => { if (!cancelled) setSrc(u); }).catch(() => { if (!cancelled) setSrc(null); });
    return () => { cancelled = true; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [url, key, nonce]);

  return src;
}
