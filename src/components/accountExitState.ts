import { useSyncExternalStore } from "react";

import type { SyncLogLine } from "@/hooks/useInitialSync";

/**
 * Account-exit progress store, the mirror of
 * {@link "@/components/syncGateState".setSyncGateActive}. Raised synchronously
 * on click; drawn by {@link AccountExitGate}. A module store, not component
 * state, because the exit unmounts the signed-in subtree before the reload.
 * Nothing clears it — the reload is the reset.
 */

export type AccountExitKind = "logout" | "switch";

export interface AccountExitState {
  kind: AccountExitKind;
  /** The outgoing pubkey, seeding the interference field (empty if unknown). */
  seed: string;
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

/** Raise the overlay. Idempotent: the first caller wins. */
export function beginAccountExit(kind: AccountExitKind, seed = ""): void {
  if (state !== null) return;
  state = { kind, seed, log: [] };
  emit();
}

/** Mark a new step running, resolving the previous. No-op before {@link beginAccountExit}. */
export function exitStep(id: string, text: string): void {
  if (!state) return;
  state = { ...state, log: [...seal(state.log), { id, text }] };
  emit();
}

export function exitDone(text: string): void {
  if (!state) return;
  state = {
    ...state,
    log: [...seal(state.log), { id: "done", text, status: "OK", tone: "ok" }],
  };
  emit();
}

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
