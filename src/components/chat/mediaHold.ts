import { createContext, useContext } from "react";

/**
 * Which authors' sender-chosen images wait (see `concord/lib/mediaTrust.ts`):
 * `media` is message media, behind an explicit "Load"; `avatar` is the profile
 * picture and banner, shown as initials. Absent provider = load everything, so
 * surfaces that don't hold (DMs, NIP-29) are unchanged. The value must be
 * memoized: every message body and avatar reads it.
 */
export interface MediaHold {
  media: (pubkey: string) => boolean;
  avatar: (pubkey: string) => boolean;
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
