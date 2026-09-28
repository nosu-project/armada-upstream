import { useSyncExternalStore } from "react";

/**
 * Per-account proof that AppConfig notification settings aren't fresh-install
 * defaults: written after a NIP-78 doc is applied, or a complete live read proves it absent.
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
 * Whether the current notification settings are the chosen policy. Sync off is
 * session authority but not a durable NIP-78 proof.
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
    // The in-memory proof still covers this session.
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

export function _resetNotificationSettingsAuthorityForTests(): void {
  readyAccounts.clear();
  listeners.clear();
}
