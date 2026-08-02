import { useCallback, useMemo } from "react";

import { MAX_STARTED_DMS } from "@/contexts/AppContext";
import { useAppContext } from "@/hooks/useAppContext";

export interface UseStartedDmsReturn {
  /** The seeded peers (hex pubkeys), oldest first. */
  started: string[];
  /** Whether this peer's row is kept without messages. */
  isStarted: (peer: string) => boolean;
  /** Keep a row for this peer until it's closed or a real message arrives. */
  start: (peer: string) => void;
}

/**
 * Read/write the DM peers whose row is kept in the list before any message
 * exists — see `startedDms` in AppConfig.
 *
 * The DM list is derived from stored messages, so this is the one input that
 * can put a row there without one. Written by the `/<user>` chat-link landing:
 * following someone's link is them asking you to talk to them, and the row has
 * to survive the first navigation away for that to mean anything.
 */
export function useStartedDms(): UseStartedDmsReturn {
  const { config, updateConfig } = useAppContext();
  const started = config.startedDms;
  const startedSet = useMemo(() => new Set(started), [started]);

  const isStarted = useCallback((peer: string) => startedSet.has(peer), [startedSet]);

  const start = useCallback(
    (peer: string) => {
      updateConfig((cur) =>
        cur.startedDms.includes(peer)
          ? cur
          : { ...cur, startedDms: [...cur.startedDms, peer].slice(-MAX_STARTED_DMS) },
      );
    },
    [updateConfig],
  );

  return { started, isStarted, start };
}
