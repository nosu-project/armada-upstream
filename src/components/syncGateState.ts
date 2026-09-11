import { useSyncExternalStore } from "react";

import { setWireGateHold } from "@/wire/bus";

/**
 * "Is the full-screen post-login SyncGate overlay up?" — a tiny standalone
 * store, split out of `SyncGate.tsx` so a hook can read the flag without
 * importing the SyncGate COMPONENT (and its heavy {@link useInitialSync}
 * subtree) and risking an import cycle. `SyncGate` owns SETTING it; everything
 * else reads.
 *
 * The post-login setup flow must not stack its steps while the overlay is
 * running (`LoginSetup`), and the occluded live surfaces underneath — the rail
 * and its per-community unread badges — must not pay for warm-up churn nobody
 * can see (`useCommunityRumors`). Both read this.
 */

let gateActive = false;
const listeners = new Set<() => void>();

/**
 * Set by `SyncGate` as it mounts/leaves. Notifies subscribers on change, and
 * drives the wire bus's doorbell hold so every occluded live surface (the rail
 * and its per-community/folder/pin unread probes) stays quiet under the overlay
 * and catches up in one batch when it lifts — not just the surfaces that happen
 * to read this flag directly.
 */
export function setSyncGateActive(next: boolean): void {
  if (gateActive === next) return;
  gateActive = next;
  setWireGateHold(next);
  for (const l of listeners) l();
}

/**
 * Non-reactive read, for use inside a stable callback/ref (e.g. a wire-bus
 * handler subscribed once) where re-subscribing on every change is undesirable.
 */
export function getSyncGateActive(): boolean {
  return gateActive;
}

/** Whether the full-screen post-login sync overlay is currently showing. */
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

/** Test helper: force the flag back to its initial state. */
export function _resetSyncGateStateForTests(): void {
  gateActive = false;
  setWireGateHold(false);
  listeners.clear();
}
