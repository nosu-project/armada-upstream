import { MutedPubkeysContext } from "@/contexts/MutedPubkeysContext";
import { useMutedPubkeysSource } from "@/hooks/useMuteList";

import type { ReactNode } from "react";

/**
 * Resolves the user's NIP-51 mute list once and hands it to the whole tree.
 *
 * Mounted high enough to cover the wire and the notification sinks as well as
 * the router: a muted person must not raise a toast or an OS notification any
 * more than they may appear in a timeline, and both of those live outside
 * `AppRouter`.
 */
export function MutedPubkeysProvider({ children }: { children: ReactNode }) {
  const value = useMutedPubkeysSource();
  return (
    <MutedPubkeysContext.Provider value={value}>
      {children}
    </MutedPubkeysContext.Provider>
  );
}
