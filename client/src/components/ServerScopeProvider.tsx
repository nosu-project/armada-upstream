import type { ReactNode } from "react";

import { ServerScopeContext } from "@/contexts/ServerScopeContext";

/**
 * Provide a server (relay URL) scope to the subtree. Anything rendered inside
 * resolves per-server nicknames against this relay.
 */
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
