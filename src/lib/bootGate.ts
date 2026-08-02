/**
 * The boot paint gate: background ingest waits for the first local paint.
 *
 * Everything at boot shares one thread. The profiler showed the local reads the
 * first paint is made of (community list, control fold, channel timeline —
 * ~100ms of actual work) queueing for SECONDS behind boot network ingest:
 * relay replays, list fetches, and their per-event parse/verify/store, all
 * kicked off the moment the providers mounted. The deferral is lossless for
 * the drivers gated on this: they are cursor- and staleTime-driven catch-up,
 * so starting late means starting from a marginally deeper cursor, not
 * missing anything.
 *
 * The gate opens on the FIRST of:
 *  - {@link markBootPainted} — the timeline painted its first rows, or a fresh
 *    login raised SyncGate (nothing local to paint; sync IS the boot);
 *  - a short timeout, so a route that never calls it (an empty channel, the
 *    welcome screen, the DMs landing) cannot hold ingest hostage.
 *
 * One-way: once open it never closes, so a gated component mounts exactly once
 * and its own effects take over from there.
 */
import { useSyncExternalStore } from "react";

/**
 * How long ingest can be held waiting for a first paint that never comes.
 *
 * Sized ABOVE the measured production warm-boot paint (~4s to first rows):
 * at 2500ms the gate opened after the channels resolved but before the
 * timeline's store read finished, so the read competed with the ingest flood
 * it existed to be protected from (measured: a 4s c2 store read landing right
 * on the first-rows timestamp). The cost of the margin is only ever paid on a
 * route that never marks a paint (an empty channel, the DMs landing), where
 * sync starts this much later.
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
 * Run `listener` once, when the gate opens (immediately if it already has).
 * Returns a cancel. The non-React seam: the sync scheduler is a plain module,
 * not a component, and needs the same "wait for first paint" deferral as the
 * mounted ingest drivers.
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

// Under vitest the gate starts open: the suites mount the ingest components
// directly and assert on their immediate behaviour; the gate's own tests use
// the seam below. In the app the timer arms at module load — imports evaluate
// before the first render, so this reads as "N ms after the bundle evaluated".
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
