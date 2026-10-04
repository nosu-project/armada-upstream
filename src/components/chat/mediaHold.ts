import { createContext, useCallback, useContext, useMemo, useSyncExternalStore } from "react";

import { isMessageRevealed, subscribeRevealed } from "@/components/chat/revealedMedia";
import { AppContext } from "@/contexts/AppContext";

/**
 * Which authors' message media waits behind an explicit "Load" (see
 * `concord/lib/mediaTrust.ts`): `media` by sender; `host` holds one media URL whose
 * host the viewer doesn't know (`lib/knownMediaHosts.ts`), whoever sent it. Absent
 * provider = load everything, so surfaces that don't hold (DMs, NIP-29) are
 * unchanged. The value must be memoized: every message body reads it.
 */
export interface MediaHold {
  /** The reader's autoload mode, for the held card's wording. */
  mode: "always" | "trusted" | "never";
  media: (pubkey: string) => boolean;
  host: (pubkey: string, url: string) => boolean;
}

export const MediaHoldContext = createContext<MediaHold | null>(null);

export { revealMessageMedia } from "@/components/chat/revealedMedia";

export function useMessageRevealed(id: string | undefined): boolean {
  return useSyncExternalStore(subscribeRevealed, () => isMessageRevealed(id));
}

export function useMediaHeld(pubkey: string | undefined): boolean {
  const hold = useContext(MediaHoldContext);
  return Boolean(hold && pubkey && hold.media(pubkey));
}

/**
 * Per-URL hold for one message: nothing once the reader loaded it, else the author's
 * own hold, else the URL's host.
 */
export function useMediaUrlHold(pubkey: string | undefined, messageId: string | undefined): (url: string) => boolean {
  const hold = useContext(MediaHoldContext);
  const revealed = useMessageRevealed(messageId);
  return useMemo(() => {
    if (!hold || !pubkey || revealed) return NEVER;
    if (hold.media(pubkey)) return ALWAYS;
    return (url: string) => hold.host(pubkey, url);
  }, [hold, pubkey, revealed]);
}

/** The reader's autoload mode inside a hold, or undefined outside one. */
export function useMediaHoldMode(): MediaHold["mode"] | undefined {
  return useContext(MediaHoldContext)?.mode;
}

/** Adds a host to `trustedMediaHosts`, so its media loads from then on; undefined outside the app's config. */
export function useTrustMediaHost(): ((host: string) => void) | undefined {
  const updateConfig = useContext(AppContext)?.updateConfig;
  const trust = useCallback(
    (host: string) => {
      const h = host.toLowerCase();
      updateConfig?.((current) =>
        current.trustedMediaHosts.includes(h)
          ? current
          : { ...current, trustedMediaHosts: [...current.trustedMediaHosts, h] },
      );
    },
    [updateConfig],
  );
  return updateConfig ? trust : undefined;
}

const NEVER = () => false;
const ALWAYS = () => true;
