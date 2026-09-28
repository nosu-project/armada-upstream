import { useSyncExternalStore } from "react";

import { getSyncTasks, onSyncActivity, type SyncTask } from "@/lib/syncActivity";

function subscribe(onStoreChange: () => void): () => void {
  return onSyncActivity(onStoreChange);
}

/**
 * In-flight background catch-up tasks (src/lib/syncActivity.ts). Debounce with useDelayedFlag
 * so fast syncs show nothing.
 */
export function useSyncTasks(): readonly SyncTask[] {
  return useSyncExternalStore(subscribe, getSyncTasks);
}
