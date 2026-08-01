import { useSyncExternalStore } from "react";

/**
 * "Is the signup wizard still running?" — a session-only, app-wide flag.
 *
 * The `WelcomePage` account-creation wizard logs the user in BEFORE its profile
 * and create/join steps render (the key has to exist to sign the profile), and
 * it deliberately suppresses the post-login `SyncGate` so a brand-new account
 * isn't held behind a network sync it has nothing to fetch for. That leaves the
 * post-login flow with no signal that onboarding is still in progress: anything
 * gated only on "is there a user?" (the headless web-push opt-in, the native
 * notification step) fires the instant login completes and paints its own
 * full-screen step over the profile step.
 *
 * This is that missing signal. `WelcomePage` sets it — synchronously, right
 * before `login.*` so it's already true on the commit that first exposes the
 * user (beating effect-ordering races) — and clears it when the wizard
 * unmounts. Consumers hold their prompts until it's false.
 */

let onboarding = false;
const listeners = new Set<() => void>();

/** Set/clear the flag. Call synchronously before login so it wins the race. */
export function setOnboardingActive(next: boolean): void {
  if (onboarding === next) return;
  onboarding = next;
  for (const l of listeners) l();
}

/** Non-reactive read (for headless call-time checks). */
export function isOnboardingActive(): boolean {
  return onboarding;
}

/** Whether the signup wizard is currently in progress. */
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
