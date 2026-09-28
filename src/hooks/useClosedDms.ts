import { useCallback } from "react";

import { useAppContext } from "@/hooks/useAppContext";

import type { ClosedDmMarker } from "@/contexts/AppContext";

export interface DmLatestMarker {
  id?: string;
  created_at: number;
}

/**
 * A closed row stays hidden only while its newest message is the one present at
 * close (or older). A different id in the same second counts as new (1s precision).
 */
export function dmRemainsClosed(
  marker: ClosedDmMarker | undefined,
  latest: DmLatestMarker | undefined,
): boolean {
  if (!marker) return false;
  if (!latest) return true;
  if (latest.created_at < marker.createdAt) return true;
  if (latest.created_at > marker.createdAt) return false;
  if (!marker.eventId || !latest.id) return true;
  return latest.id === marker.eventId;
}

export function useClosedDms() {
  const { config, updateConfig } = useAppContext();

  const isClosed = useCallback(
    (peer: string, latest: DmLatestMarker | undefined) =>
      dmRemainsClosed(config.closedDms[peer], latest),
    [config.closedDms],
  );

  const close = useCallback(
    (peer: string, latest: DmLatestMarker | undefined) => {
      updateConfig((current) => ({
        ...current,
        // A reopened row returns unpinned.
        pinnedDms: current.pinnedDms.filter((p) => p !== peer),
        closedDms: {
          ...current.closedDms,
          [peer]: {
            eventId: latest?.id,
            createdAt: latest?.created_at ?? Math.floor(Date.now() / 1000),
          },
        },
      }));
    },
    [updateConfig],
  );

  const reopen = useCallback(
    (peer: string) => {
      updateConfig((current) => {
        if (!current.closedDms[peer]) return current;
        const closedDms = { ...current.closedDms };
        delete closedDms[peer];
        return { ...current, closedDms };
      });
    },
    [updateConfig],
  );

  const reopenForNewMessages = useCallback(
    (rows: Array<{ peer: string; latest: DmLatestMarker | undefined }>) => {
      updateConfig((current) => {
        let closedDms: Record<string, ClosedDmMarker> | undefined;
        for (const row of rows) {
          const marker = current.closedDms[row.peer];
          if (!marker || dmRemainsClosed(marker, row.latest)) continue;
          closedDms ??= { ...current.closedDms };
          delete closedDms[row.peer];
        }
        return closedDms ? { ...current, closedDms } : current;
      });
    },
    [updateConfig],
  );

  return { close, reopen, reopenForNewMessages, isClosed };
}
