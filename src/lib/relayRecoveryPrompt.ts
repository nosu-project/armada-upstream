/** Per-account marker for the one-time "restore your setup" prompt (see `LoginSetup`). */

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
 * Opt out of the recovery prompt: brand-new accounts have nothing to recover,
 * and LoginSetup marks it once shown so a force-quit isn't re-asked.
 */
export function markRelayRecoveryPromptShown(pubkey: string): void {
  try {
    localStorage.setItem(key(pubkey), "1");
  } catch { /* ignore */ }
}

/** Undo the marker: backing out signs out, and signing back in should ask again. */
export function clearRelayRecoveryPromptShown(pubkey: string): void {
  try {
    localStorage.removeItem(key(pubkey));
  } catch { /* ignore */ }
}
