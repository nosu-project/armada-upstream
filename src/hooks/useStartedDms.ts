import { useCallback, useMemo } from "react";

import { MAX_STARTED_DMS } from "@/contexts/AppContext";
import { useAppContext } from "@/hooks/useAppContext";

export interface UseStartedDmsReturn {
  started: string[];
  /** Whether this peer's row is kept without messages. */
  isStarted: (peer: string) => boolean;
  /** Kept until closed or a real message arrives. */
  start: (peer: string) => void;
}

/**
 * DM peers whose row exists before any message (`startedDms` in AppConfig), written by the
 * `/<user>` chat-link landing.
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
