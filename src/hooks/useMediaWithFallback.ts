import { useCallback, useMemo, useState, useSyncExternalStore } from "react";

import { getBuzzMediaHostsVersion, isBuzzMediaUrl, subscribeBuzzMediaHosts } from "@/buzz/media";
import { MAX_EXPLICIT_DECRYPT_BYTES } from "@/lib/encryptedMedia";

import { useRoutedCandidates, useSourceWalk } from "./useBlossomCandidates";
import { useResolvedMediaSrc } from "./useResolvedMediaSrc";

import type { MediaFallbackProps } from "@/components/chat/MediaFallback";
import type { EncryptedRef } from "./useResolvedMediaSrc";

// The candidate order lives in `@/lib/blossom`; re-exported so the existing
// callers and tests keep their import.
export { mediaCandidates } from "@/lib/blossom";

type ResolvedState = ReturnType<typeof useResolvedMediaSrc>;

export interface MediaWithFallback {
  /** The resolved media state for the currently-tried server. */
  resolved: ResolvedState;
  /** Wire onto the media element's `onError` — advances to the next mirror. */
  onError: () => void;
  /** True once nothing is going to render — every mirror failed, or it's oversized. */
  failed: boolean;
  /** Restart from the first server — the manual retry after total failure. */
  reset: () => void;
  /**
   * Everything {@link MediaFallback} needs for this reference, so each call
   * site spreads one object instead of re-deriving the oversized/retry wiring.
   */
  fallbackProps: Omit<MediaFallbackProps, "label" | "className" | "compact">;
}

/**
 * Resolve a media reference to a displayable `src` WITH cross-server fallback,
 * under the viewer's media policy.
 *
 * Wraps {@link useResolvedMediaSrc} (which handles plain, encrypted and
 * Buzz-authed blobs) and, for a content-addressed Blossom URL, walks the same
 * `/<sha256>` blob across the user's other effective Blossom servers when a
 * load fails — the read side of the BUD-04 mirroring the uploader already does.
 * A dead or not-yet-mirrored server transparently fails over to the next copy.
 *
 * The policy is applied to the candidate list before anything loads
 * (`useRoutedCandidates`): with a proxy set, the sender's host is loaded
 * through it, so an `<img>` in a message cannot learn the viewer's address
 * just by being scrolled past. A Buzz-hosted blob bypasses the policy: it
 * needs a signed header no proxy forwards, and its host is a relay the viewer
 * joined.
 *
 * WHO walks depends on who can see the failure:
 *
 * - A plain URL is loaded by the element, so the element's `onError` advances
 *   a {@link useSourceWalk} over the candidates, one `src` at a time.
 * - An encrypted blob is fetched by the resolver, so every candidate is handed
 *   to it and tried INSIDE one resolve (`fetchCapped`). This used to be driven
 *   by an effect on the resolver's status string, which stalled whenever a
 *   mirror failed before React committed the intervening "loading" render —
 *   error → error is not a transition — and left the walk parked on the second
 *   server with `failed` still false: an empty placeholder, no retry, exactly
 *   in the fast-failure cases (offline, a blocked host) fallback exists for.
 *
 * The walk resets whenever `ref.url` changes, so a re-rendered or edited
 * message re-attempts from the top instead of inheriting a stale failure.
 */
export function useMediaWithFallback(ref: EncryptedRef): MediaWithFallback {
  const encrypted = Boolean(ref.encryption?.algorithm);
  // Re-evaluate Buzz-ness when the host registry grows (see useResolvedMediaSrc).
  useSyncExternalStore(subscribeBuzzMediaHosts, getBuzzMediaHostsVersion);
  const buzz = !encrypted && isBuzzMediaUrl(ref.url);
  const { sources } = useRoutedCandidates(ref.url, ref.fallbacks, { bypass: buzz });

  // The encrypted path has one thing to render — the decrypted bytes — so its
  // element walk is a single step: an `onError` on the object URL (bytes that
  // are not an image at all) goes straight to `failed`.
  const elementCandidates = useMemo(
    () => (encrypted ? sources.slice(0, 1) : sources),
    [encrypted, sources],
  );
  const walk = useSourceWalk(elementCandidates);

  // Raised past the inline cap once the user asks for an oversized blob anyway,
  // remembered per URL so a changed reference starts under the cap again.
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
  // "error" is terminal: the fetch walk already tried every candidate, or the
  // encryption is one we cannot apply. NOT "oversized": every mirror is the
  // same content-addressed blob, so it is oversized on all of them.
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
