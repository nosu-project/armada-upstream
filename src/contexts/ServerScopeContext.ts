import { createContext, useContext } from "react";

/**
 * The relay being viewed, so nested components can resolve per-server nicknames.
 * `undefined` (e.g. DMs) = global profile names.
 */
export const ServerScopeContext = createContext<string | undefined>(undefined);

/** Read the current server (relay URL) scope, if any. */
export function useServerScope(): string | undefined {
  return useContext(ServerScopeContext);
}
