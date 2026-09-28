import { useEffect } from "react";

/**
 * Module-level bus asking the active composer to start a bot command (like the
 * mention bus). Seeds the draft with `/name` and focuses it, reusing the typed-slash
 * path. Composer subscribes via `useCommandRequests`; callers use `requestCommand(name)`.
 */
type CommandListener = (name: string) => void;

const listeners = new Set<CommandListener>();

/** Ask the active composer to start `/name`. False when no composer is mounted. */
export function requestCommand(name: string): boolean {
  for (const listener of listeners) listener(name);
  return listeners.size > 0;
}

/** Subscribe the active composer's command starter to those requests. */
export function useCommandRequests(start: (name: string) => void) {
  useEffect(() => {
    listeners.add(start);
    return () => {
      listeners.delete(start);
    };
  }, [start]);
}
