import { useCallback, useEffect, useSyncExternalStore } from "react";

import { onSyncState, syncState, want, type SyncPriority, type SyncState } from "@/sync/syncManager";

const NO_TOPIC: SyncState = Object.freeze({ status: "idle" });

/**
 * Declare interest in a sync topic for the life of the component, and read
 * its state reactively.
 *
 * The network side of a store-first hook: the component's query reads
 * ArmadaDB only, this asks the sync layer to keep the topic fresh, and the
 * returned state drives the loading-skeleton gate (skeleton iff the local
 * read was empty AND the topic has never settled).
 */
export function useSyncTopic(topic: string | undefined, priority: SyncPriority = "visible"): SyncState {
  useEffect(() => {
    if (topic === undefined) return;
    return want(topic, priority);
  }, [topic, priority]);

  const subscribe = useCallback(
    (listener: () => void) => (topic === undefined ? () => undefined : onSyncState(topic, listener)),
    [topic],
  );
  const getSnapshot = useCallback(
    () => (topic === undefined ? NO_TOPIC : syncState(topic)),
    [topic],
  );
  return useSyncExternalStore(subscribe, getSnapshot, getSnapshot);
}
