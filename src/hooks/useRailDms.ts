import { useCallback, useMemo } from "react";

import { useAppContext } from "@/hooks/useAppContext";
import { useRemoveRailKey } from "@/hooks/useRemoveRailKey";
import {
  dmRailKey,
  flattenLayout,
  normalizeLayout,
  railDmPubkeys,
} from "@/lib/railLayout";

export interface UseRailDmsReturn {
  /** Peer pubkeys on the rail, in visual order. */
  railDms: string[];
  isOnRail: (peer: string) => boolean;
  addToRail: (peer: string) => void;
  removeFromRail: (peer: string) => void;
  toggleRail: (peer: string) => void;
}

/**
 * Put a DM on the community rail (a `dm:` key in `railLayout`, synced via NIP-78) and take it
 * off. New entries go to the TOP: `mergeLayout` appends unknown live items after the stored
 * arrangement, so the top is the only stable position.
 */
export function useRailDms(): UseRailDmsReturn {
  const { config, updateConfig } = useAppContext();
  const removeRailKey = useRemoveRailKey();

  const railDms = useMemo(
    () => railDmPubkeys(config.railLayout),
    [config.railLayout],
  );

  const isOnRail = useCallback((peer: string) => railDms.includes(peer), [railDms]);

  const addToRail = useCallback(
    (peer: string) => {
      const key = dmRailKey(peer);
      updateConfig((current) => {
        if (flattenLayout(current.railLayout).includes(key)) return current;
        const railLayout = normalizeLayout([{ type: "item", key }, ...current.railLayout]);
        return { ...current, railLayout };
      });
    },
    [updateConfig],
  );

  const removeFromRail = useCallback(
    (peer: string) => removeRailKey(dmRailKey(peer)),
    [removeRailKey],
  );

  const toggleRail = useCallback(
    (peer: string) => {
      if (isOnRail(peer)) removeFromRail(peer);
      else addToRail(peer);
    },
    [isOnRail, removeFromRail, addToRail],
  );

  return { railDms, isOnRail, addToRail, removeFromRail, toggleRail };
}
