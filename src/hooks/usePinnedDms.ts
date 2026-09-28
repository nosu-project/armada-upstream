import { useCallback, useMemo } from "react";

import { useAppContext } from "@/hooks/useAppContext";

export interface UsePinnedDmsReturn {
  /** Hex pubkeys; insertion order, not meaningful. */
  pinned: string[];
  /** Stable across renders for the same pinned set. */
  isPinned: (peer: string) => boolean;
  pin: (peer: string) => void;
  unpin: (peer: string) => void;
  togglePin: (peer: string) => void;
}

/**
 * Pinned DM conversations (a set), persisted to app config and synced. Pinned rows are still
 * ordered newest-first.
 */
export function usePinnedDms(): UsePinnedDmsReturn {
  const { config, updateConfig } = useAppContext();
  const pinned = config.pinnedDms;
  const pinnedSet = useMemo(() => new Set(pinned), [pinned]);

  const isPinned = useCallback((peer: string) => pinnedSet.has(peer), [pinnedSet]);

  const pin = useCallback(
    (peer: string) => {
      updateConfig((cur) =>
        cur.pinnedDms.includes(peer) ? cur : { ...cur, pinnedDms: [...cur.pinnedDms, peer] },
      );
    },
    [updateConfig],
  );

  const unpin = useCallback(
    (peer: string) => {
      updateConfig((cur) => ({ ...cur, pinnedDms: cur.pinnedDms.filter((p) => p !== peer) }));
    },
    [updateConfig],
  );

  const togglePin = useCallback(
    (peer: string) => {
      updateConfig((cur) =>
        cur.pinnedDms.includes(peer)
          ? { ...cur, pinnedDms: cur.pinnedDms.filter((p) => p !== peer) }
          : { ...cur, pinnedDms: [...cur.pinnedDms, peer] },
      );
    },
    [updateConfig],
  );

  return { pinned, isPinned, pin, unpin, togglePin };
}
