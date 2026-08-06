/**
 * Per-account marker for the one-time "restore your setup" recovery prompt
 * (see `LoginSetup`). Kept in its own module so both the onboarding flow and
 * the account wizard can touch it without a component-file cross-import.
 */

const key = (pubkey: string) => `armada:relay-prompt-shown:${pubkey}`;

/** Whether the recovery prompt has already been shown or opted out for `pubkey`. */
export function relayRecoveryPromptShown(pubkey: string): boolean {
  try {
    return localStorage.getItem(key(pubkey)) !== null;
  } catch {
    return false;
  }
}

/**
 * Opt a pubkey out of the recovery prompt. The account wizard calls this for a
 * brand-new account — it has nothing on any relay to recover, so "we couldn't
 * find your setup" would be nonsense. LoginSetup also calls it once it has
 * surfaced the prompt, so a force-quit mid-flow isn't re-asked every launch.
 */
export function markRelayRecoveryPromptShown(pubkey: string): void {
  try {
    localStorage.setItem(key(pubkey), "1");
  } catch {
    // Private mode / storage disabled — the prompt simply reappears next launch.
  }
}
