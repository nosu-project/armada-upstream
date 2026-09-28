import { useCallback, useEffect, useSyncExternalStore } from "react";

import { onSyncState, syncState, want, type SyncPriority, type SyncState } from "@/sync/syncManager";

const NO_TOPIC: SyncState = Object.freeze({ status: "idle" });

/**
 * Declare interest in a sync topic for the component's life and read its
 * state (skeleton iff the local read was empty AND the topic never settled).
 */
export function useSyncTopic(topic: string | undefined, priority: SyncPriority = "visible"): SyncState {
  useEffect(() => {
    if (topic === undefined) return;
    return want(topic, priority);
  }, [topic, priority]);

  return useSyncTopicState(topic);
}

/** Read a topic's sync state WITHOUT declaring interest. */
export function useSyncTopicState(topic: string | undefined): SyncState {
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
