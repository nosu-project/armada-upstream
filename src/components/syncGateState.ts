import { useSyncExternalStore } from "react";

import { setWireGateHold } from "@/wire/bus";

/**
 * Standalone "is SyncGate up?" store, split out so readers (LoginSetup,
 * useCommunityRumors) avoid importing SyncGate's heavy subtree and an import cycle.
 */

let gateActive = false;
const listeners = new Set<() => void>();

/** Set by `SyncGate`. Also holds the wire bus's doorbell so occluded surfaces catch up in one batch. */
export function setSyncGateActive(next: boolean): void {
  if (gateActive === next) return;
  gateActive = next;
  setWireGateHold(next);
  for (const l of listeners) l();
}

export function useSyncGateActive(): boolean {
  return useSyncExternalStore(
    (listener) => {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    () => gateActive,
    () => false,
  );
}

export function _resetSyncGateStateForTests(): void {
  gateActive = false;
  setWireGateHold(false);
  listeners.clear();
}
