import { useCallback, useMemo, useState, useSyncExternalStore } from "react";

import { getBuzzMediaHostsVersion, isBuzzMediaUrl, subscribeBuzzMediaHosts } from "@/buzz/media";
import { MAX_EXPLICIT_DECRYPT_BYTES } from "@/lib/encryptedMedia";

import { useRoutedCandidates, useSourceWalk } from "./useBlossomCandidates";
import { useResolvedMediaSrc } from "./useResolvedMediaSrc";

import type { MediaFallbackProps } from "@/components/chat/MediaFallback";
import type { EncryptedRef } from "./useResolvedMediaSrc";

// Re-exported so existing callers and tests keep their import.
export { mediaCandidates } from "@/lib/blossom";

type ResolvedState = ReturnType<typeof useResolvedMediaSrc>;

export interface MediaWithFallback {
  resolved: ResolvedState;
  /** Wire onto the element's `onError` — advances to the next mirror. */
  onError: () => void;
  /** Every mirror failed, or it's oversized. */
  failed: boolean;
  /** Manual retry after total failure. */
  reset: () => void;
  fallbackProps: Omit<MediaFallbackProps, "label" | "className" | "compact">;
}

/**
 * Resolve a media ref with cross-server Blossom fallback (walking `/<sha256>` across the user's
 * servers, BUD-04), under the media policy (proxy applied before loading). Buzz-hosted blobs bypass
 * the policy (they need a signed header).
 * Plain URLs are walked by the element's `onError` ({@link useSourceWalk}); encrypted blobs are tried
 * inside one resolve (`fetchCapped`). The walk resets when `ref.url` changes.
 */
export function useMediaWithFallback(ref: EncryptedRef): MediaWithFallback {
  const encrypted = Boolean(ref.encryption?.algorithm);
  // Re-evaluate Buzz-ness when the host registry grows (see useResolvedMediaSrc).
  useSyncExternalStore(subscribeBuzzMediaHosts, getBuzzMediaHostsVersion);
  const buzz = !encrypted && isBuzzMediaUrl(ref.url);
  const { sources } = useRoutedCandidates(ref.url, ref.fallbacks, { bypass: buzz });

  // Encrypted path: a single element step; `onError` goes straight to `failed`.
  const elementCandidates = useMemo(
    () => (encrypted ? sources.slice(0, 1) : sources),
    [encrypted, sources],
  );
  const walk = useSourceWalk(elementCandidates);

  // Remembered per URL so a changed reference starts under the cap again.
  const [oversizedAllowedFor, setOversizedAllowedFor] = useState<string | null>(null);
  const maxBytes = oversizedAllowedFor === ref.url ? MAX_EXPLICIT_DECRYPT_BYTES : undefined;

  const resolved = useResolvedMediaSrc(
    { ...ref, url: walk.src ?? ref.url },
    {
      maxBytes,
      alternates: encrypted ? sources.slice(1) : undefined,
      retryKey: walk.attempt,
    },
  );

  const oversized = resolved.status === "oversized" ? resolved.byteSize : undefined;
  // Every mirror holds the same blob, so oversized anywhere is oversized everywhere.
  const failed = walk.failed || resolved.status === "error" || oversized !== undefined;

  const { reset: resetWalk } = walk;
  const reset = useCallback(() => {
    setOversizedAllowedFor(null);
    resetWalk();
  }, [resetWalk]);

  const decryptAnyway = useCallback(() => setOversizedAllowedFor(ref.url), [ref.url]);

  return {
    resolved,
    onError: walk.advance,
    failed,
    reset,
    fallbackProps: {
      url: ref.url,
      onRetry: reset,
      oversized,
      onDecryptAnyway: oversized === undefined ? undefined : decryptAnyway,
    },
  };
}
