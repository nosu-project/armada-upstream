import { useCallback, useMemo } from "react";

import { useAppContext } from "@/hooks/useAppContext";
import { useRemoveRailKey } from "@/hooks/useRemoveRailKey";
import {
  dmRailKey,
  flattenLayout,
  mergeLayout,
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
 * there, so adding writes a `dm:` key into `railLayout` (and the flat
 * `railOrder` alongside it) and removing takes it back out. From that point
 * the icon is an ordinary rail item: it drags, folders and reorders like any
 * other, and rides the same encrypted NIP-78 settings document to the user's
 * other devices.
 *
 * New entries land at the end of the top level rather than beside the DMs
 * button — the arrangement is the user's, so an addition takes the one
 * position that displaces nothing they arranged.
 */
export function useRailDms(): UseRailDmsReturn {
  const { config, updateConfig } = useAppContext();
  const removeRailKey = useRemoveRailKey();

  const railDms = useMemo(
    () => railDmPubkeys(config.railLayout, config.railOrder),
    [config.railLayout, config.railOrder],
  );

  const isOnRail = useCallback((peer: string) => railDms.includes(peer), [railDms]);

  const addToRail = useCallback(
    (peer: string) => {
      const key = dmRailKey(peer);
      updateConfig((current) => {
        // Seed from the legacy flat order when no layout has been stored yet:
        // writing a layout holding only the new item would leave every server
        // and community to be re-appended by `mergeLayout` in discovery order,
        // silently replacing the arrangement the user had.
        const base = mergeLayout(current.railLayout, current.railOrder, []);
        if (flattenLayout(base).includes(key)) return current;
        const railLayout = normalizeLayout([...base, { type: "item", key }]);
        return { ...current, railLayout, railOrder: flattenLayout(railLayout) };
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
