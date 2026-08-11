import { useCallback, useEffect, useMemo, useState } from "react";

import { blossomFallbackUrls, getEffectiveBlossomServers } from "@/lib/blossom";

import { useAppContext } from "./useAppContext";
import { useResolvedMediaSrc } from "./useResolvedMediaSrc";

import type { EncryptedRef } from "./useResolvedMediaSrc";

type ResolvedState = ReturnType<typeof useResolvedMediaSrc>;

export interface MediaWithFallback {
  /** The resolved media state for the currently-tried server. */
  resolved: ResolvedState;
  /** Wire onto the media element's `onError` — advances to the next mirror. */
  onError: () => void;
  /** True once every mirror has been tried and failed. */
  failed: boolean;
  /** Restart from the first server — the manual retry after total failure. */
  reset: () => void;
}

/**
 * Resolve a media reference to a displayable `src` WITH cross-server fallback.
 *
 * Wraps {@link useResolvedMediaSrc} (which handles plain, encrypted and
 * Buzz-authed blobs) and, for a content-addressed Blossom URL, walks the same
 * `/<sha256>` blob across the user's other effective Blossom servers when a
 * load fails — the read side of the BUD-04 mirroring the uploader already does.
 * A dead or not-yet-mirrored server transparently fails over to the next copy.
 *
 * Two failure signals feed the same walk: an `<img>`/`<video>` `onError` (the
 * plain-URL path, where the element detects the failure) and the resolver's own
 * `"error"` status (the encrypted/Buzz path, where the fetch/decrypt rejects).
 *
 * The candidate index resets whenever `ref.url` changes, so a re-rendered or
 * edited message re-attempts from the top instead of inheriting a stale
 * failure — the "broken image renders permanently as a link until refresh" bug.
 */
export function useMediaWithFallback(ref: EncryptedRef): MediaWithFallback {
  const { config } = useAppContext();
  const { blossomServerMetadata, useAppBlossomServers } = config;

  // The primary URL first, then the same blob on every other server. Memoized
  // on primitive/stable identity so it doesn't rebuild every render (callers
  // pass a fresh `EncryptedRef` object each time).
  const candidates = useMemo(
    () => [
      ref.url,
      ...blossomFallbackUrls(
        ref.url,
        getEffectiveBlossomServers(blossomServerMetadata, useAppBlossomServers),
      ),
    ],
    [ref.url, blossomServerMetadata, useAppBlossomServers],
  );

  // Index into `candidates`; reaching `candidates.length` means every mirror
  // has been exhausted. Reset when the source URL changes.
  const [index, setIndex] = useState(0);
  useEffect(() => {
    setIndex(0);
  }, [ref.url]);

  const failed = index >= candidates.length;
  const activeUrl = candidates[Math.min(index, candidates.length - 1)] ?? ref.url;

  const resolved = useResolvedMediaSrc({ ...ref, url: activeUrl });

  const advance = useCallback(
    () => setIndex((i) => (i < candidates.length ? i + 1 : i)),
    [candidates.length],
  );

  // The encrypted/Buzz path surfaces failure as a status rather than an element
  // `onError`; advance on that transition just as the element handler would.
  useEffect(() => {
    if (resolved.status === "error") advance();
  }, [resolved.status, advance]);

  const reset = useCallback(() => setIndex(0), []);

  return { resolved, onError: advance, failed, reset };
}
