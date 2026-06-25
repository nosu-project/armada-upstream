import { useEffect, useState } from "react";

import { decryptImageToObjectURL } from "@/lib/concord/communityImage";

import type { CommunityImage } from "@/lib/concord/types";

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
const cache = new Map<string, Promise<string>>();

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
  const [src, setSrc] = useState<string | null>(null);

  useEffect(() => {
    if (!image || !url || !key || !nonce) {
      setSrc(null);
      return;
    }
    let cancelled = false;
    const ck = cacheKey(image);
    let promise = cache.get(ck);
    if (!promise) {
      promise = decryptImageToObjectURL(image);
      cache.set(ck, promise);
      promise.catch(() => {
        if (cache.get(ck) === promise) cache.delete(ck);
      });
      if (cache.size > MAX_CACHED) {
        const oldest = cache.keys().next().value;
        if (oldest !== undefined && oldest !== ck) cache.delete(oldest);
      }
    }
    setSrc(null);
    promise.then((u) => { if (!cancelled) setSrc(u); }).catch(() => { if (!cancelled) setSrc(null); });
    return () => { cancelled = true; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [url, key, nonce]);

  return src;
}
