import { useCallback, useMemo, useRef, useState } from "react";

import { mediaCandidates } from "@/lib/blossom";
import { routeMediaCandidates } from "@/lib/mediaPolicy";

import { useBlossomServers } from "./useBlossomServers";
import { useMediaPolicy } from "./useMediaPolicy";

// The server list lives in its own module (see there for why); re-exported so
// the existing callers and tests keep their import.
export { useBlossomServers } from "./useBlossomServers";

/**
 * Cross-server media fallback, in three composable pieces.
 *
 * A Blossom URL is content-addressed (`/<sha256>`), and the uploader mirrors
 * every blob across the effective server list (BUD-04), so the same bytes are
 * usually reachable on several hosts. Everything that renders or fetches such a
 * URL should therefore try the other hosts before giving up — and should decide
 * the ORDER in exactly one place ({@link mediaCandidates}), whether the walk is
 * then driven by an `<img>`'s `onError` ({@link useSourceWalk}) or by a `fetch`
 * loop (`fetchCapped`).
 *
 * - {@link useBlossomServers}: the viewer's effective server list, memoized.
 * - {@link useBlossomCandidates}: that list applied to one URL.
 * - {@link useRoutedCandidates}: the candidates under the viewer's media
 *   policy — proxied when a proxy is set, loaded directly when it is not.
 * - {@link useSourceWalk}: an index over any candidate list, advanced by the
 *   element's error and reset by a manual retry.
 * - {@link useImageFallback}: the lot composed, for a plain `<img>`.
 */

/**
 * The ordered sources for one media reference: the URL, the sender's declared
 * `fallback`s (sanitized), then the same blob on the viewer's other servers.
 * Memoized on the URLs' CONTENT, since callers routinely rebuild the fallback
 * array every render. Empty when there is no URL.
 */
export function useBlossomCandidates(
  url: string | undefined,
  declaredFallbacks?: readonly string[],
): string[] {
  const servers = useBlossomServers();
  // A URL cannot contain a newline, so joining on one is a faithful identity.
  const declaredKey = declaredFallbacks?.join("\n") ?? "";
  return useMemo(
    () => (url ? mediaCandidates(url, declaredKey ? declaredKey.split("\n") : undefined, servers) : []),
    [url, declaredKey, servers],
  );
}

/**
 * {@link useBlossomCandidates} under the viewer's media policy: the sources to
 * load, each in the form it loads in — proxied when a proxy is set, direct
 * otherwise. `bypass` skips the policy for a source the policy has no business
 * touching — a Buzz-hosted blob, whose signed GET header a proxy would not
 * forward and whose host is a relay the viewer joined.
 */
export function useRoutedCandidates(
  url: string | undefined,
  declaredFallbacks?: readonly string[],
  opts: { bypass?: boolean } = {},
): { sources: string[] } {
  const candidates = useBlossomCandidates(url, declaredFallbacks);
  const policy = useMediaPolicy();
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
 * An index over a candidate list, driven by whatever detects a failure.
 *
 * Resets to the first candidate whenever the PRIMARY changes, synchronously in
 * render, so a re-rendered or edited reference never paints one frame at a
 * stale index — the "broken image renders permanently as a link until refresh"
 * bug was a walk that inherited a previous URL's failure.
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
 * A plain `<img>`'s cross-server fallback: `src` to render, `onError` to wire,
 * `failed` once nothing is left to try. For an avatar, a badge, a banner, a
 * custom emoji — any image that is not a chat attachment (those go through
 * `useMediaWithFallback`, which also decrypts).
 *
 * Under the media policy: `src` is already the proxied form when a proxy is
 * set, so a caller that renders nothing without a `src` (every avatar and
 * emoji) keeps working unchanged.
 */
export function useImageFallback(
  url: string | undefined,
  declaredFallbacks?: readonly string[],
): { src: string | undefined; onError: () => void; failed: boolean; reset: () => void } {
  const { sources } = useRoutedCandidates(url, declaredFallbacks);
  const { src, advance, failed, reset } = useSourceWalk(sources);
  return { src, onError: advance, failed, reset };
}
