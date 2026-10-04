import { useCallback, useState } from "react";

import { useRoutedCandidates, useSourceWalk } from "./useBlossomCandidates";
import { useResolvedMediaSrc } from "./useResolvedMediaSrc";

import type { ImetaEntry } from "@/lib/imeta";

export interface ImetaImage {
  /** What to put in `src`. Undefined while an encrypted image decrypts. */
  src: string | undefined;
  /** Wire onto the element's `onError`. */
  onError: () => void;
  /** Nothing left to try: render the placeholder. */
  failed: boolean;
  /** An encrypted image is still being fetched and decrypted. */
  pending: boolean;
  /** Start over from the first source. Stable. */
  reset: () => void;
}

const NONE: readonly string[] = [];

/**
 * A plain `<img>` source described by `imeta` (already matched to `src`, see
 * `imetaFor`), under the media policy. Plain: walks the declared `fallback`s,
 * then the viewer's Blossom servers. Encrypted: fetched across the same list
 * and decrypted, never shown raw — that would paint ciphertext. Decrypts are
 * cached per file (`encryptedMedia.ts`), so an avatar repeated down a
 * timeline is fetched once.
 */
export function useImetaImage(src: string | undefined, imeta: ImetaEntry | undefined): ImetaImage {
  const encryption = imeta?.encryption;
  const { sources } = useRoutedCandidates(src, imeta?.fallbacks);
  const walk = useSourceWalk(encryption ? NONE : sources);

  const [retryKey, setRetryKey] = useState(0);
  const resolved = useResolvedMediaSrc(
    encryption && sources[0] ? { url: sources[0], encryption, mime: imeta?.mime } : "",
    { alternates: encryption ? sources.slice(1) : undefined, retryKey },
  );

  // A decrypted blob the browser can't decode is as dead as a failed fetch.
  const decrypted = encryption && resolved.status === "ready" ? resolved.src : undefined;
  const [broken, setBroken] = useState<string>();
  const markBroken = useCallback(() => setBroken(decrypted), [decrypted]);

  const { reset: resetWalk } = walk;
  const reset = useCallback(() => {
    resetWalk();
    setBroken(undefined);
    setRetryKey((k) => k + 1);
  }, [resetWalk]);

  if (encryption) {
    return {
      src: decrypted,
      onError: markBroken,
      failed: !sources[0] || resolved.status === "error" || resolved.status === "oversized" || (!!decrypted && broken === decrypted),
      pending: resolved.status === "loading",
      reset,
    };
  }
  return { src: walk.src, onError: walk.advance, failed: walk.failed, pending: false, reset };
}
