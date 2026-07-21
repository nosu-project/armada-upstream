import { useEffect, useState, useSyncExternalStore } from "react";

import {
  getBuzzMediaHostsVersion,
  isBuzzMediaUrl,
  resolveBuzzMediaObjectURL,
  subscribeBuzzMediaHosts,
} from "@/buzz/media";

/** Resolution state for a possibly-Buzz media URL. */
export interface BuzzMediaSrc {
  /** The `src` to display: an authed object URL, or the original URL. */
  src: string | undefined;
  loading: boolean;
  error: boolean;
}

/**
 * Resolve a media URL to a displayable `src`, transparently authenticating
 * Buzz-hosted media (see `@/buzz/media`). For any non-Buzz URL this returns the
 * URL unchanged with no effect/fetch, so it's safe on hot paths (every avatar,
 * every inline image). For a Buzz media URL it fetches the blob with a signed
 * BUD-11 GET header and returns an object URL.
 *
 * Subscribes to the Buzz host registry so a URL that wasn't yet recognized as
 * Buzz (its relay's NIP-11 hadn't resolved) re-resolves once the host registers.
 */
export function useBuzzMediaSrc(url: string | undefined): BuzzMediaSrc {
  // Re-evaluate `isBuzzMediaUrl` whenever the host registry grows.
  useSyncExternalStore(subscribeBuzzMediaHosts, getBuzzMediaHostsVersion);
  const isBuzz = isBuzzMediaUrl(url);

  const [state, setState] = useState<BuzzMediaSrc>({
    src: url,
    loading: false,
    error: false,
  });

  useEffect(() => {
    if (!url || !isBuzz) {
      setState({ src: url, loading: false, error: false });
      return;
    }
    let cancelled = false;
    const controller = new AbortController();
    setState({ src: undefined, loading: true, error: false });
    resolveBuzzMediaObjectURL(url, controller.signal)
      .then((src) => {
        if (!cancelled) setState({ src, loading: false, error: false });
      })
      .catch(() => {
        if (!cancelled) setState({ src: undefined, loading: false, error: true });
      });
    return () => {
      cancelled = true;
      controller.abort();
    };
  }, [url, isBuzz]);

  return state;
}
