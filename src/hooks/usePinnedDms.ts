import { useCallback, useMemo } from "react";

import { useAppContext } from "@/hooks/useAppContext";

export interface UsePinnedDmsReturn {
  /** Pinned peers (hex pubkeys) in pin order — oldest pin first. */
  pinned: string[];
  /** Membership test, stable across renders for the same pinned set. */
  isPinned: (peer: string) => boolean;
  /** Pin a peer, appending it to the end of the pinned section. */
  pin: (peer: string) => void;
  /** Unpin a peer. */
  unpin: (peer: string) => void;
  /** Pin or unpin, whichever the peer currently isn't. */
  togglePin: (peer: string) => void;
}

/**
 * Read/write the user's pinned DM conversations, persisted to app config and
 * synced across devices.
 *
 * Pin order is insertion order (a new pin lands at the bottom of the pinned
 * section) and is independent of message recency, so a pinned conversation
 * holds its place as messages arrive elsewhere.
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
