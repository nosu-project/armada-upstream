import { useSyncExternalStore } from "react";

import type { SyncLogLine } from "@/hooks/useInitialSync";

/**
 * "Is an account exit in flight, and how far along?" — a tiny standalone module
 * store, the mirror image of {@link "@/components/syncGateState".setSyncGateActive}
 * on the way out.
 *
 * Logging out or switching accounts runs a bounded, best-effort teardown and
 * then navigates. Until this store existed the dropdown just closed and the app
 * sat on the old screen for seconds, so a press read as no press. The exit paths
 * now {@link beginAccountExit} SYNCHRONOUSLY on click — before any await — and
 * report each real step as it runs ({@link exitStep}/{@link exitDone}), which
 * {@link AccountExitGate} draws as the login sequence in reverse: the crest, the
 * dead-channel static, and a terminal log naming exactly what is taking time.
 *
 * It is a module store rather than component state on purpose: the exit clears
 * the login moments before it reloads, which unmounts the whole signed-in
 * subtree. State that lived there would vanish with it and flash the app back
 * for the sliver before the reload. Living out here, the overlay stays up until
 * `location.assign` replaces the page. Nothing ever clears it — the reload is
 * the reset.
 */

/** Which exit is running — drives the overlay's wording. */
export type AccountExitKind = "logout" | "switch";

export interface AccountExitState {
  kind: AccountExitKind;
  /** The outgoing pubkey, seeding the interference field (empty if unknown). */
  seed: string;
  /** The teardown log, newest last — the terminal feed. */
  log: SyncLogLine[];
}

let state: AccountExitState | null = null;
const listeners = new Set<() => void>();

function emit(): void {
  for (const l of listeners) l();
}

/** Resolve every still-running line to OK, so only the newest is ever live. */
function seal(log: SyncLogLine[]): SyncLogLine[] {
  return log.map((l) =>
    l.status === undefined ? { ...l, status: "OK", tone: "ok" as const } : l,
  );
}

/**
 * Raise the account-exit overlay. Idempotent: the first caller wins, so a
 * teardown that flips it and a reload that never comes leave one consistent
 * screen up rather than flickering between kinds.
 */
export function beginAccountExit(kind: AccountExitKind, seed = ""): void {
  if (state !== null) return;
  state = { kind, seed, log: [] };
  emit();
}

/**
 * Mark a new teardown step as running (a spinner), resolving whatever ran
 * before it. A no-op before {@link beginAccountExit}, so a step reported off a
 * path that didn't raise the overlay is simply dropped.
 */
export function exitStep(id: string, text: string): void {
  if (!state) return;
  state = { ...state, log: [...seal(state.log), { id, text }] };
  emit();
}

/** Resolve everything and land a final settled line. */
export function exitDone(text: string): void {
  if (!state) return;
  state = {
    ...state,
    log: [...seal(state.log), { id: "done", text, status: "OK", tone: "ok" }],
  };
  emit();
}

/** The exit in flight, or `null` when none is. Reactive; drives the overlay. */
export function useAccountExit(): AccountExitState | null {
  return useSyncExternalStore(
    (listener) => {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    () => state,
    () => null,
  );
}

/** Test helper: force the store back to its initial state. */
export function _resetAccountExitStateForTests(): void {
  state = null;
  listeners.clear();
}
