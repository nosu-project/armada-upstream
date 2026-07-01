import { useEffect } from "react";

import { writeTimelineSnapshot } from "@/lib/timelineSnapshot";

/** Debounce between snapshot writes, so a burst of live messages coalesces. */
const WRITE_DEBOUNCE_MS = 800;

/**
 * Persist a timeline's newest screenful to the shared localStorage snapshot
 * (see {@link writeTimelineSnapshot}) whenever it changes, debounced.
 *
 * Mounted by each timeline hook (NIP-29 / Concord / DM) alongside its query;
 * pass the query's data. `scope === undefined` or empty data is a no-op, so
 * callers don't need their own guards.
 */
export function useTimelineSnapshotWriter(
  scope: string | undefined,
  items: readonly unknown[] | undefined,
): void {
  useEffect(() => {
    if (!scope || !items || items.length === 0) return;
    const t = setTimeout(() => writeTimelineSnapshot(scope, items), WRITE_DEBOUNCE_MS);
    return () => clearTimeout(t);
  }, [scope, items]);
}
