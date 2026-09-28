import { useEffect, useState, useSyncExternalStore } from "react";

import {
  getBuzzMediaHostsVersion,
  isBuzzMediaUrl,
  resolveBuzzMediaObjectURL,
  subscribeBuzzMediaHosts,
} from "@/buzz/media";

export interface BuzzMediaSrc {
  /** The `src` to display: an authed object URL, or the original URL. */
  src: string | undefined;
  loading: boolean;
  error: boolean;
}

/**
 * Resolve a media URL to a displayable `src`, authenticating Buzz-hosted media
 * (see `@/buzz/media`). Non-Buzz URLs pass through with no fetch. Re-resolves
 * when the host registry grows.
 */
export function useBuzzMediaSrc(url: string | undefined): BuzzMediaSrc {
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
