import { createContext, useContext, useMemo } from "react";

/**
 * Which authors' sender-chosen images wait (see `concord/lib/mediaTrust.ts`):
 * `media` is message media, behind an explicit "Load"; `avatar` is the profile
 * picture and banner, shown as initials; `host` holds one media URL whose host
 * the viewer doesn't know (`lib/knownMediaHosts.ts`), whoever sent it. Absent provider = load everything, so
 * surfaces that don't hold (DMs, NIP-29) are unchanged. The value must be
 * memoized: every message body and avatar reads it.
 */
export interface MediaHold {
  media: (pubkey: string) => boolean;
  avatar: (pubkey: string) => boolean;
  host: (pubkey: string, url: string) => boolean;
}

export const MediaHoldContext = createContext<MediaHold | null>(null);

export function useMediaHeld(pubkey: string | undefined): boolean {
  const hold = useContext(MediaHoldContext);
  return Boolean(hold && pubkey && hold.media(pubkey));
}

export function useAvatarHeld(pubkey: string | undefined): boolean {
  const hold = useContext(MediaHoldContext);
  return Boolean(hold && pubkey && hold.avatar(pubkey));
}

/** Per-URL hold for one author's message: the author's own hold, or the URL's host. */
export function useMediaUrlHold(pubkey: string | undefined): (url: string) => boolean {
  const hold = useContext(MediaHoldContext);
  return useMemo(() => {
    if (!hold || !pubkey) return NEVER;
    if (hold.media(pubkey)) return ALWAYS;
    return (url: string) => hold.host(pubkey, url);
  }, [hold, pubkey]);
}

const NEVER = () => false;
const ALWAYS = () => true;
