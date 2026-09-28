import { useCallback } from "react";

import { useAppContext } from "@/hooks/useAppContext";
import { removeKey } from "@/lib/railLayout";

/**
 * Purge a community from `railLayout` when it's removed from its source list, or it reappears
 * in its old folder on rejoin. Called from the list-mutation hooks so every removal path prunes.
 */
export function useRemoveRailKey(): (key: string) => void {
  const { updateConfig } = useAppContext();

  return useCallback(
    (key: string) => {
      updateConfig((current) => {
        const railLayout = removeKey(current.railLayout, key);
        // Don't churn the config (and the NIP-78 publish watcher) when nothing changed.
        if (JSON.stringify(railLayout) === JSON.stringify(current.railLayout)) return current;
        return { ...current, railLayout };
      });
    },
    [updateConfig],
  );
}
