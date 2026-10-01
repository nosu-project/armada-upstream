import { createContext, useContext } from "react";

/**
 * Whether an author's media must wait for an explicit "Load" (see
 * `concord/lib/mediaTrust.ts`). Absent provider = load everything, so surfaces
 * that don't hold (DMs, NIP-29) are unchanged. The value must be memoized: every
 * message body reads it.
 */
export const MediaHoldContext = createContext<((pubkey: string) => boolean) | null>(null);

export function useMediaHeld(pubkey: string | undefined): boolean {
  const holds = useContext(MediaHoldContext);
  return Boolean(holds && pubkey && holds(pubkey));
}
