import { useCallback, useContext, useMemo, useRef, useState } from "react";

import { AppContext } from "@/contexts/AppContext";
import { APP_BLOSSOM_SERVERS, getEffectiveBlossomServers, mediaCandidates } from "@/lib/blossom";

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
 * - {@link useSourceWalk}: an index over any candidate list, advanced by the
 *   element's error and reset by a manual retry.
 * - {@link useImageFallback}: the two composed, for a plain `<img>`.
 */

/**
 * The viewer's effective Blossom server list, stable across renders.
 *
 * Reads the context directly rather than through `useAppContext`, which throws
 * without a provider: this sits under every avatar, so it must render wherever
 * an avatar does. With no config in reach the app defaults stand in — the same
 * list a fresh install has.
 */
export function useBlossomServers(): string[] {
  const config = useContext(AppContext)?.config;
  const appBlossomServers = config?.appBlossomServers ?? APP_BLOSSOM_SERVERS;
  const blossomServerMetadata = config?.blossomServerMetadata;
  const useAppBlossomServers = config?.useAppBlossomServers ?? true;
  return useMemo(
    () =>
      blossomServerMetadata
        ? getEffectiveBlossomServers(appBlossomServers, blossomServerMetadata, useAppBlossomServers)
        : [...appBlossomServers],
    [appBlossomServers, blossomServerMetadata, useAppBlossomServers],
  );
}

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
 */
export function useImageFallback(
  url: string | undefined,
  declaredFallbacks?: readonly string[],
): { src: string | undefined; onError: () => void; failed: boolean; reset: () => void } {
  const candidates = useBlossomCandidates(url, declaredFallbacks);
  const { src, advance, failed, reset } = useSourceWalk(candidates);
  return { src, onError: advance, failed, reset };
}
