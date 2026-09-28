/**
 * Boot paint gate: background ingest waits for the first local paint, which
 * otherwise queued for seconds behind boot network ingest. Lossless for the
 * gated drivers (cursor/staleTime catch-up). Opens once, on the first of
 * {@link markBootPainted} (first rows, or a fresh login's SyncGate) or a timeout.
 */
import { useSyncExternalStore } from "react";

/**
 * Max hold for a paint that never comes; sized above the measured ~4s warm-boot
 * first paint (2.5s let ingest collide with the timeline's store read).
 */
const BOOT_GATE_TIMEOUT_MS = 5000;

let open = false;
const listeners = new Set<() => void>();

function notify(): void {
  for (const listener of [...listeners]) listener();
}

/** Open the gate: the first local paint has committed (or never will exist). */
export function markBootPainted(): void {
  if (open) return;
  open = true;
  notify();
}

/** Whether the gate is open (non-reactive read). */
export function isBootGateOpen(): boolean {
  return open;
}

/**
 * Run `listener` once when the gate opens (immediately if open); returns a
 * cancel. For non-React callers like the sync scheduler.
 */
export function onBootGateOpen(listener: () => void): () => void {
  if (open) {
    listener();
    return () => undefined;
  }
  const once = (): void => {
    listeners.delete(once);
    listener();
  };
  listeners.add(once);
  return () => {
    listeners.delete(once);
  };
}

/** Reactive gate state, for mounting the deferred ingest drivers. */
export function useBootGateOpen(): boolean {
  return useSyncExternalStore(
    (listener) => {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    () => open,
    () => open,
  );
}

// Under vitest the gate starts open; in the app the timer arms at module load.
if (import.meta.env?.MODE === "test") {
  open = true;
} else {
  setTimeout(markBootPainted, BOOT_GATE_TIMEOUT_MS);
}

/** Test seam: force the gate state (and notify subscribers). */
export function _setBootGateForTests(value: boolean): void {
  open = value;
  notify();
}
