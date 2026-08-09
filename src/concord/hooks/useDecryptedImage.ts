import { useEffect, useState } from "react";

import { decryptImagePointer } from "@/concord/lib/image";
import type { ImagePointer } from "@/concord/lib/types";

/**
 * Resolve an encrypted Concord {@link ImagePointer} (icon / banner) to a
 * displayable object URL. Decrypt-once cache per
 * (url, key, nonce), synchronous seeding from the resolved cache so a remount
 * paints on the first frame, object URLs never revoked (bounded cache).
 */

const MAX_CACHED = 128;
const cache = new Map<string, Promise<string>>();
const resolved = new Map<string, string>();

function cacheKey(image: ImagePointer): string {
  return `${image.url}\n${image.key}\n${image.nonce}`;
}

/**
 * The same decrypt-once resolution as {@link useDecryptedImage}, for callers
 * that aren't components — the foreground notifier needs a community's icon for
 * a notification, from a sink that runs outside the React tree.
 *
 * Shares this module's caches deliberately: a community whose icon is already
 * on screen costs the notifier nothing, and the two never mint two object URLs
 * for one image.
 */
export function resolveDecryptedImage(image: ImagePointer): Promise<string> {
  const ck = cacheKey(image);
  const ready = resolved.get(ck);
  if (ready) return Promise.resolve(ready);

  let promise = cache.get(ck);
  if (!promise) {
    promise = decryptImagePointer(image);
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
  return promise;
}

/** Returns the decrypted object URL, or null while loading / on failure. */
export function useDecryptedImage(image: ImagePointer | undefined): string | null {
  const url = image?.url;
  const key = image?.key;
  const nonce = image?.nonce;
  const [src, setSrc] = useState<string | null>(() =>
    image ? resolved.get(cacheKey(image)) ?? null : null,
  );

  useEffect(() => {
    if (!image || !url || !key || !nonce) {
      setSrc(null);
      return;
    }
    const ck = cacheKey(image);
    const ready = resolved.get(ck);
    if (ready) {
      setSrc(ready);
      return;
    }

    let cancelled = false;
    setSrc(null);
    resolveDecryptedImage(image)
      .then((u) => {
        if (!cancelled) setSrc(u);
      })
      .catch(() => {
        if (!cancelled) setSrc(null);
      });
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [url, key, nonce]);

  return src;
}
