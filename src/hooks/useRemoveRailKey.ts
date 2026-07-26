import { useCallback } from "react";

import { useAppContext } from "@/hooks/useAppContext";
import { removeKey } from "@/lib/railLayout";

/**
 * Purge a community from the rail's arrangement.
 *
 * Removing a community has to hit BOTH the source list (kind 10009, the
 * Concord V1/V2 Community Lists) and the arrangement, or the key lingers in
 * `railLayout`/`railOrder` — invisible, because rendering filters against the
 * live lists, right up until the user rejoins and finds the community back in
 * its old folder at its old position.
 *
 * Called from the three list-mutation hooks rather than from each menu item,
 * so every removal path — leave, dissolve, decline, removed-by-ban — prunes
 * without having to remember to.
 */
export function useRemoveRailKey(): (key: string) => void {
  const { updateConfig } = useAppContext();

  return useCallback(
    (key: string) => {
      updateConfig((current) => {
        const railLayout = removeKey(current.railLayout, key);
        const railOrder = current.railOrder.filter((k) => k !== key);
        // Don't churn the config (and with it the NIP-78 publish watcher) when
        // the key wasn't in the arrangement to begin with.
        if (
          railOrder.length === current.railOrder.length &&
          JSON.stringify(railLayout) === JSON.stringify(current.railLayout)
        ) {
          return current;
        }
        return { ...current, railLayout, railOrder };
      });
    },
    [updateConfig],
  );
}
