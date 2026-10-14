import { useSyncExternalStore } from "react";

/**
 * Per-account "this key exists only on this device" marker. Signup sets it when
 * it mints a key; it clears once the key has left the screen (copy, file,
 * keyring, share). Device-local on purpose: an account signed in anywhere else
 * was signed in with a key the user already had. Purged with the rest of
 * localStorage at final logout.
 */

const PREFIX = "armada:key-backup-pending:";
const key = (pubkey: string) => PREFIX + pubkey;

/** The first reminder waits this long after signup, so onboarding itself isn't interrupted. */
export const KEY_BACKUP_FIRST_REMINDER_MS = 60 * 60 * 1000;
/** "Later" pushes the reminder back this far. */
export const KEY_BACKUP_SNOOZE_MS = 24 * 60 * 60 * 1000;

const listeners = new Set<() => void>();
const notify = () => {
  for (const l of listeners) l();
};

function write(pubkey: string, remindAt: number): void {
  try {
    localStorage.setItem(key(pubkey), JSON.stringify({ remindAt }));
  } catch { /* ignore */ }
  notify();
}

/** When the reminder is next due, or `null` when the key isn't awaiting a backup. */
export function keyBackupRemindAt(pubkey: string): number | null {
  let raw: string | null;
  try {
    raw = localStorage.getItem(key(pubkey));
  } catch {
    return null;
  }
  if (raw === null) return null;
  // A marker we can't read still means "not backed up": remind now rather than never.
  try {
    const remindAt = (JSON.parse(raw) as { remindAt?: unknown } | null)?.remindAt;
    return typeof remindAt === "number" ? remindAt : 0;
  } catch {
    return 0;
  }
}

export function keyBackupPending(pubkey: string): boolean {
  return keyBackupRemindAt(pubkey) !== null;
}

/** A key signup just minted: its only copy is on this device. */
export function markKeyBackupPending(pubkey: string, now = Date.now()): void {
  write(pubkey, now + KEY_BACKUP_FIRST_REMINDER_MS);
}

export function snoozeKeyBackupReminder(pubkey: string, now = Date.now()): void {
  if (!keyBackupPending(pubkey)) return;
  write(pubkey, now + KEY_BACKUP_SNOOZE_MS);
}

/** The key has left the screen, or the account it belongs to is going away. */
export function clearKeyBackupPending(pubkey: string): void {
  try {
    localStorage.removeItem(key(pubkey));
  } catch { /* ignore */ }
  notify();
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  // Another tab backing the key up counts here too.
  const onStorage = (e: StorageEvent) => {
    if (e.key === null || e.key.startsWith(PREFIX)) listener();
  };
  window.addEventListener("storage", onStorage);
  return () => {
    listeners.delete(listener);
    window.removeEventListener("storage", onStorage);
  };
}

/** {@link keyBackupRemindAt}, live. */
export function useKeyBackupRemindAt(pubkey: string | undefined): number | null {
  return useSyncExternalStore(
    subscribe,
    () => (pubkey ? keyBackupRemindAt(pubkey) : null),
    () => null,
  );
}
