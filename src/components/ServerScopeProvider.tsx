import type { ReactNode } from "react";

import { ServerScopeContext } from "@/contexts/ServerScopeContext";

/** Per-server nickname scope (relay URL) for the subtree. */
export function ServerScopeProvider({
  relayUrl,
  children,
}: {
  relayUrl: string | undefined;
  children: ReactNode;
}) {
  return (
    <ServerScopeContext.Provider value={relayUrl}>
      {children}
    </ServerScopeContext.Provider>
  );
}
