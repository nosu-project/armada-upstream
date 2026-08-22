import { useSyncExternalStore } from "react";

/**
 * Per-account proof that the notification settings currently in AppConfig are
 * not merely a fresh install's defaults. The proof is written only after a
 * persisted NIP-78 notification document has been applied, or a complete live
 * self-relay read has proved that document absent.
 */
const NOTIFICATION_SETTINGS_READY_PREFIX = "armada:notification-settings-ready:v1:";

const readyAccounts = new Set<string>();
const listeners = new Set<() => void>();

function storageKey(pubkey: string): string {
  return `${NOTIFICATION_SETTINGS_READY_PREFIX}${pubkey}`;
}

/** Whether this account has a distinguishable trusted notification snapshot. */
export function notificationSettingsReady(pubkey: string | undefined): boolean {
  if (!pubkey) return false;
  if (readyAccounts.has(pubkey)) return true;
  try {
    if (localStorage.getItem(storageKey(pubkey)) !== "1") return false;
    readyAccounts.add(pubkey);
    return true;
  } catch {
    return false;
  }
}

/**
 * Whether the current AppConfig notification slice is the chosen policy.
 *
 * Turning automatic settings sync off is an explicit choice to use this
 * device's account-scoped config. That is session authority, but deliberately
 * not a durable NIP-78 proof: re-enabling sync must resume waiting for an
 * applied document or a complete live absence read.
 */
export function notificationPolicyIsAuthoritative(
  durableReady: boolean,
  automaticSettingsSync: boolean,
): boolean {
  return durableReady || automaticSettingsSync === false;
}

/** Persist and publish notification-settings authority for one account. */
export function markNotificationSettingsReady(pubkey: string | undefined): void {
  if (!pubkey || readyAccounts.has(pubkey)) return;
  readyAccounts.add(pubkey);
  try {
    localStorage.setItem(storageKey(pubkey), "1");
  } catch {
    // The in-memory proof still protects this session. A future offline boot
    // will conservatively wait for the stored document/source again.
  }
  for (const listener of [...listeners]) listener();
}

/** React view of the per-account authority proof. */
export function useNotificationSettingsReady(pubkey: string | undefined): boolean {
  return useSyncExternalStore(
    (listener) => {
      listeners.add(listener);
      return () => { listeners.delete(listener); };
    },
    () => notificationSettingsReady(pubkey),
    () => false,
  );
}

/** Test seam. Persistent state remains controlled by localStorage. */
export function _resetNotificationSettingsAuthorityForTests(): void {
  readyAccounts.clear();
  listeners.clear();
}
