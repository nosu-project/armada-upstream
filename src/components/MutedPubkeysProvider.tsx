import { MutedPubkeysContext } from "@/contexts/MutedPubkeysContext";
import { useMutedPubkeysSource } from "@/hooks/useMuteList";

import type { ReactNode } from "react";

/** Resolves the NIP-51 mute list once. Mounted above the wire and notification sinks, which live outside `AppRouter`. */
export function MutedPubkeysProvider({ children }: { children: ReactNode }) {
  const value = useMutedPubkeysSource();
  return (
    <MutedPubkeysContext.Provider value={value}>
      {children}
    </MutedPubkeysContext.Provider>
  );
}
