import { useCallback, useEffect, useMemo, useState } from "react";

import { blossomFallbackUrls, getEffectiveBlossomServers } from "@/lib/blossom";
import { MAX_EXPLICIT_DECRYPT_BYTES } from "@/lib/encryptedMedia";
import { isLocalNetworkUrl, sanitizeUrl } from "@/lib/sanitizeUrl";

import { useAppContext } from "./useAppContext";
import { useResolvedMediaSrc } from "./useResolvedMediaSrc";

import type { MediaFallbackProps } from "@/components/chat/MediaFallback";
import type { EncryptedRef } from "./useResolvedMediaSrc";

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
/**
 * The ordered list of sources to try for one media reference.
 *
 * The primary URL first, then the sender's own `fallback` entries, then the
 * same content-addressed blob on every other Blossom server. Declared
 * fallbacks outrank derived mirrors because the sender knows where they
 * actually put the blob, while a mirror is only a guess that a copy exists
 * there.
 *
 * The declared ones are raw event data, so they are sanitized HERE rather than
 * at each of the dozen places a ref is built — a `javascript:` or LAN fallback
 * must not reach a `fetch` or an `<img src>` by any route. Exported for
 * testing, and pure so that walk is checkable without a renderer.
 */
export function mediaCandidates(
  url: string,
  declaredFallbacks: string[] | undefined,
  blossomServers: string[],
): string[] {
  const seen = new Set<string>([url]);
  const out = [url];
  for (const raw of declaredFallbacks ?? []) {
    const safe = sanitizeUrl(raw);
    if (!safe || isLocalNetworkUrl(safe) || seen.has(safe)) continue;
    seen.add(safe);
    out.push(safe);
  }
  for (const mirror of blossomFallbackUrls(url, blossomServers)) {
    if (seen.has(mirror)) continue;
    seen.add(mirror);
    out.push(mirror);
  }
  return out;
}

export function useMediaWithFallback(ref: EncryptedRef): MediaWithFallback {
  const { config } = useAppContext();
  const { appBlossomServers, blossomServerMetadata, useAppBlossomServers } = config;

  // Memoized on primitive/stable identity so it doesn't rebuild every render
  // (callers pass a fresh `EncryptedRef` object each time).
  const declaredFallbacks = ref.fallbacks;
  const candidates = useMemo(
    () =>
      mediaCandidates(
        ref.url,
        declaredFallbacks,
        getEffectiveBlossomServers(appBlossomServers, blossomServerMetadata, useAppBlossomServers),
      ),
    [ref.url, declaredFallbacks, appBlossomServers, blossomServerMetadata, useAppBlossomServers],
  );

  // Index into `candidates`; reaching `candidates.length` means every mirror
  // has been exhausted. Reset when the source URL changes.
  const [index, setIndex] = useState(0);
  // Raised past the inline cap once the user asks for an oversized blob anyway.
  const [maxBytes, setMaxBytes] = useState<number | undefined>(undefined);
  useEffect(() => {
    setIndex(0);
    setMaxBytes(undefined);
  }, [ref.url]);

  const activeUrl = candidates[Math.min(index, candidates.length - 1)] ?? ref.url;

  const resolved = useResolvedMediaSrc({ ...ref, url: activeUrl }, { maxBytes });

  const advance = useCallback(
    () => setIndex((i) => (i < candidates.length ? i + 1 : i)),
    [candidates.length],
  );

  // The encrypted/Buzz path surfaces failure as a status rather than an element
  // `onError`; advance on that transition just as the element handler would.
  // NOT for "oversized", though: every mirror is the same content-addressed
  // blob, so it is oversized on all of them and walking them would be a fetch
  // per server to learn the same thing.
  useEffect(() => {
    if (resolved.status === "error") advance();
  }, [resolved.status, advance]);

  const oversized = resolved.status === "oversized" ? resolved.byteSize : undefined;
  const failed = index >= candidates.length || oversized !== undefined;

  const reset = useCallback(() => {
    setIndex(0);
    setMaxBytes(undefined);
  }, []);

  const decryptAnyway = useCallback(() => setMaxBytes(MAX_EXPLICIT_DECRYPT_BYTES), []);

  return {
    resolved,
    onError: advance,
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
