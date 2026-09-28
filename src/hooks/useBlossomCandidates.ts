import { useCallback, useMemo, useRef, useState } from "react";

import { mediaCandidates } from "@/lib/blossom";
import { routeMediaCandidates } from "@/lib/mediaPolicy";

import { useBlossomServers } from "./useBlossomServers";
import { useMediaProxyRotation } from "./useMediaPolicy";

/**
 * Cross-server media fallback. Blossom URLs are content-addressed and mirrored
 * (BUD-04), so renderers try other hosts; ORDER is decided only in
 * {@link mediaCandidates}.
 * - {@link useBlossomCandidates}: the server list applied to one URL.
 * - {@link useRoutedCandidates}: those under the media policy (proxied or direct).
 * - {@link useSourceWalk}: an index advanced by errors, reset on retry.
 * - {@link useImageFallback}: all composed, for a plain `<img>`.
 */

/**
 * Ordered sources for a media reference: URL, sanitized sender `fallback`s, then
 * the blob on the viewer's servers. Memoized on URL content. Empty without a URL.
 */
export function useBlossomCandidates(
  url: string | undefined,
  declaredFallbacks?: readonly string[],
): string[] {
  const servers = useBlossomServers();
  // URLs can't contain newlines, so joining on one is a faithful identity.
  const declaredKey = declaredFallbacks?.join("\n") ?? "";
  return useMemo(
    () => (url ? mediaCandidates(url, declaredKey ? declaredKey.split("\n") : undefined, servers) : []),
    [url, declaredKey, servers],
  );
}

/**
 * {@link useBlossomCandidates} under the media policy. `bypass` skips it for e.g.
 * Buzz-hosted blobs, whose signed GET header a proxy wouldn't forward.
 */
export function useRoutedCandidates(
  url: string | undefined,
  declaredFallbacks?: readonly string[],
  opts: { bypass?: boolean } = {},
): { sources: string[] } {
  const candidates = useBlossomCandidates(url, declaredFallbacks);
  const policy = useMediaProxyRotation();
  const bypass = opts.bypass ?? false;
  return useMemo(
    () => (bypass ? { sources: candidates } : routeMediaCandidates(candidates, policy)),
    [bypass, candidates, policy],
  );
}

export interface SourceWalk {
  /** The candidate to load now; `undefined` only when there are none. */
  src: string | undefined;
  /** Wire onto the element's `onError` — moves to the next candidate. */
  advance: () => void;
  /** True once every candidate has failed. Never true for an empty list. */
  failed: boolean;
  /** Start over from the first candidate — the manual retry. */
  reset: () => void;
  /** Bumped by each `reset`, for effects that must re-run a fetch on retry. */
  attempt: number;
}

/**
 * An index over a candidate list. Resets synchronously in render when the
 * PRIMARY changes, so a new URL never inherits a previous one's failure.
 */
export function useSourceWalk(candidates: readonly string[]): SourceWalk {
  const [index, setIndex] = useState(0);
  const [attempt, setAttempt] = useState(0);

  const primary = candidates[0];
  const prevPrimary = useRef(primary);
  if (prevPrimary.current !== primary) {
    prevPrimary.current = primary;
    if (index !== 0) setIndex(0);
  }

  const length = candidates.length;
  const advance = useCallback(() => setIndex((i) => Math.min(i + 1, length)), [length]);
  const reset = useCallback(() => {
    setIndex(0);
    setAttempt((a) => a + 1);
  }, []);

  return {
    src: candidates[Math.min(index, length - 1)],
    advance,
    failed: length > 0 && index >= length,
    reset,
    attempt,
  };
}

/**
 * A plain `<img>`'s cross-server fallback (avatars, banners, emoji — not chat
 * attachments, which use `useMediaWithFallback`). `src` is already
 * policy-routed.
 */
export function useImageFallback(
  url: string | undefined,
  declaredFallbacks?: readonly string[],
): { src: string | undefined; onError: () => void; failed: boolean; reset: () => void } {
  const { sources } = useRoutedCandidates(url, declaredFallbacks);
  const { src, advance, failed, reset } = useSourceWalk(sources);
  return { src, onError: advance, failed, reset };
}
