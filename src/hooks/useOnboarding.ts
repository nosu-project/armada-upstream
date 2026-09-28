import { useSyncExternalStore } from "react";

/**
 * Session-only "signup wizard still running" flag. `WelcomePage` logs in before its profile
 * steps and suppresses SyncGate, so post-login prompts must wait on this. Set synchronously before
 * `login.*`; cleared on unmount.
 */

let onboarding = false;
const listeners = new Set<() => void>();

/** Call synchronously before login so it wins the race. */
export function setOnboardingActive(next: boolean): void {
  if (onboarding === next) return;
  onboarding = next;
  for (const l of listeners) l();
}

export function useOnboardingActive(): boolean {
  return useSyncExternalStore(
    (listener) => {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    () => onboarding,
    () => false,
  );
}
