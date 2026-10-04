import { createContext, useSyncExternalStore } from "react";

/**
 * True while a mobile `SwipeReveal` has slid its pane aside to show the list
 * beneath, so surfaces inside the pane know they are off screen.
 */
export const PaneCoveredContext = createContext(false);

// The same fact app-wide, for fixed chrome outside the pane (the mobile call bar).
const covered = new Set<symbol>();
const listeners = new Set<() => void>();

export function setPaneCovered(token: symbol, value: boolean): void {
  if (value === covered.has(token)) return;
  if (value) covered.add(token);
  else covered.delete(token);
  for (const listener of listeners) listener();
}

function subscribe(listener: () => void) {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

/** Whether a mobile list (rail + channels) is on screen. */
export function useListShowing(): boolean {
  return useSyncExternalStore(subscribe, () => covered.size > 0);
}
