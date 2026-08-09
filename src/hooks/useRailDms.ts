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
  /** Peer pubkeys currently on the rail, in the rail's visual order. */
  railDms: string[];
  isOnRail: (peer: string) => boolean;
  addToRail: (peer: string) => void;
  removeFromRail: (peer: string) => void;
  toggleRail: (peer: string) => void;
}

/**
 * Put a DM conversation on the community rail, and take it off again.
 *
 * Unlike a server or a community, a DM has no membership list behind it — the
 * rail arrangement itself is the record that the user wanted this person
 * there, so adding writes a `dm:` key into `railLayout` and removing takes it
 * back out. From that point the icon is an ordinary rail item: it drags,
 * folders and reorders like any other, and rides the rail's encrypted NIP-78
 * document to the user's other devices.
 *
 * New entries go to the TOP of the rail, directly under the DMs button. The
 * end is not available to us: the stored arrangement holds only what the user
 * has actually arranged, and `mergeLayout` appends every live server and
 * community it doesn't yet know AFTER it — so appending here puts the icon
 * ahead of all of those, i.e. in the middle. The top is the one position that
 * is the same before and after that append.
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
