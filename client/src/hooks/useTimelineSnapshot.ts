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
 *
 * `enabled` MUST be false while the query is showing another conversation's
 * data (TanStack `keepPreviousData` / `placeholderData`): on a room switch the
 * scope flips to the NEW room immediately while `query.data` still holds the
 * PREVIOUS room's messages, and if the new room's first read outlasts the
 * debounce, the old room's timeline would be persisted under the new room's
 * key — cross-room pollution that `initialData` then replays on every launch.
 * Pass `!query.isPlaceholderData` for such queries.
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
