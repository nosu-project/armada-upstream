import { useEffect, useState } from "react";

import { decryptImagePointer } from "@/concord/lib/image";
import type { ImagePointer } from "@/concord/lib/types";
import { useBlossomServers } from "@/hooks/useBlossomServers";
import { useMediaPolicy } from "@/hooks/useMediaPolicy";

import type { MediaPolicy } from "@/lib/mediaPolicy";

/**
 * Decrypt-once cache per (url, key, nonce); object URLs are never revoked,
 * so the cache is bounded.
 */

const MAX_CACHED = 128;
const cache = new Map<string, Promise<string>>();
const resolved = new Map<string, string>();

function cacheKey(image: ImagePointer): string {
  return `${image.url}\n${image.key}\n${image.nonce}`;
}

/**
 * Non-hook form of {@link useDecryptedImage} (e.g. for the notifier), sharing
 * its caches so one image never mints two object URLs. `servers` are Blossom
 * hosts tried after the pointer's own; `policy` is the viewer's media policy.
 */
export function resolveDecryptedImage(
  image: ImagePointer,
  servers?: readonly string[],
  policy?: MediaPolicy,
): Promise<string> {
  const ck = cacheKey(image);
  const ready = resolved.get(ck);
  if (ready) return Promise.resolve(ready);

  let promise = cache.get(ck);
  if (!promise) {
    promise = decryptImagePointer(image, undefined, servers, policy);
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
  const servers = useBlossomServers();
  const policy = useMediaPolicy();
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
    resolveDecryptedImage(image, servers, policy)
      .then((u) => {
        if (!cancelled) setSrc(u);
      })
      .catch(() => {
        if (!cancelled) setSrc(null);
      });
    return () => {
      cancelled = true;
    };
    // Server list and policy are read once per resolve, not re-applied to icons on screen.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [url, key, nonce]);

  return src;
}
