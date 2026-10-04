import { createContext, useContext } from "react";

import type { VoiceIdentityResolver } from "@/contexts/VoiceIdentityContext";

/**
 * Screen shares are opt-in: nobody receives another member's stream until they
 * choose to watch it. Keyed by STREAMER (see
 * {@link streamOwnerKey}), so a desktop H.265 share's companion video and the
 * sharer's own screen audio follow one decision.
 */
export interface ScreenShareWatch {
  /** Streamers this client is watching. */
  watching: ReadonlySet<string>;
  watch: (owner: string) => void;
  stopWatching: (owner: string) => void;
}

const NONE: ReadonlySet<string> = new Set();

export const ScreenShareWatchContext = createContext<ScreenShareWatch>({
  watching: NONE,
  watch: () => {},
  stopWatching: () => {},
});

export function useScreenShareWatch(): ScreenShareWatch {
  return useContext(ScreenShareWatchContext);
}

/** Who a participant's stream belongs to: the verified pubkey, else the bare identity. */
export function streamOwnerKey(identity: string, resolveIdentity: VoiceIdentityResolver): string {
  const resolved = resolveIdentity(identity);
  return resolved.verified ? resolved.pubkey : identity;
}
