import { useEffect } from "react";

import { writeTimelineSnapshot } from "@/lib/timelineSnapshot";

/** Coalesces bursts of live messages. */
const WRITE_DEBOUNCE_MS = 800;

/**
 * Persist a timeline's newest screenful to the localStorage snapshot (debounced). `enabled`
 * MUST be false while showing placeholder data (pass `!query.isPlaceholderData`), or the previous
 * room's messages get persisted under the new room's key.
 */
export function useTimelineSnapshotWriter(
  scope: string | undefined,
  items: readonly unknown[] | undefined,
  enabled: boolean = true,
): void {
  useEffect(() => {
    if (!enabled || !scope || !items || items.length === 0) return;
    const t = setTimeout(() => writeTimelineSnapshot(scope, items), WRITE_DEBOUNCE_MS);
    return () => clearTimeout(t);
  }, [scope, items, enabled]);
}
