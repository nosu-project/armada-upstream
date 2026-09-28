/**
 * The device-local bookkeeping every nostr-push controller keeps.
 *
 * Shared by `useNostrPush` (Web Push / Tenna) and `useIosPush` (APNs) — one
 * device runs only one of them, so they are the same facts under the same keys
 * rather than a per-platform copy that could disagree about what "on" means:
 *
 *  - the user's INTENT, which is not the same as the OS permission. Intent is
 *    opt-out and survives a revoked-then-regranted permission, so returning to
 *    the app repairs push instead of silently leaving it off.
 *  - the per-type prefs, which are account-global and shared with the Android
 *    service and the in-app notifier too (see `pushPrefs.ts`).
 *  - the subscription ids the iOS path last registered with the legacy
 *    gateway. Registrations there are per-record and outlive the process, so
 *    this is the only durable record of what needs pruning when the watch set
 *    shrinks. (The web path hands over whole lists; see `nappPush.ts`.)
 */

import {
  savePushPrefs as saveAccountPushPrefs,
  type PushPrefs,
} from "@/lib/pushPrefs";

const INTENT_KEY = "armada:push-intent";
const SUBS_KEY = "armada:nostr-push-subs";
/** Stable browser/app installation identity (`nativePush.ts`). */
export const PUSH_INSTALLATION_KEY = "armada:push-install";

function uniqueSortedIds(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return [...new Set(value.filter((id): id is string => typeof id === "string"))].sort();
}

/** Whether the user still intends push to be on (opt-out; default true). */
export function loadPushIntent(): boolean {
  try {
    const raw = localStorage.getItem(INTENT_KEY);
    return raw === null ? true : raw === "true";
  } catch {
    return true;
  }
}

export function savePushIntent(on: boolean): void {
  try {
    localStorage.setItem(INTENT_KEY, String(on));
  } catch {
    // ignore
  }
}

export function savePushPrefs(prefs: PushPrefs, pubkey?: string | null): void {
  saveAccountPushPrefs(prefs, pubkey);
}

/** The subscription ids we last registered — the prune list. */
export function loadRegisteredPushIds(): string[] {
  try {
    const raw = localStorage.getItem(SUBS_KEY);
    if (raw) {
      const parsed: unknown = JSON.parse(raw);
      if (Array.isArray(parsed)) {
        return parsed.filter((id): id is string => typeof id === "string");
      }
    }
  } catch {
    // ignore
  }
  return [];
}

export function saveRegisteredPushIds(ids: string[]): void {
  try {
    localStorage.setItem(SUBS_KEY, JSON.stringify(uniqueSortedIds(ids)));
  } catch {
    // ignore
  }
}

/**
 * A stable id for this browser/app install.
 *
 * Legacy nostr-push registration is replace-by-id, so two installs sharing an
 * origin need different ids. Local storage makes the
 * value stable across ordinary reloads; a storage reset intentionally creates
 * a new install identity. When storage is unavailable the session-only value
 * still avoids sharing another install's record.
 */
let ephemeralInstallationId: string | undefined;
export function pushInstallationId(): string {
  try {
    const existing = localStorage.getItem(PUSH_INSTALLATION_KEY);
    if (existing) return existing;
    const id = typeof crypto !== "undefined" && "randomUUID" in crypto
      ? crypto.randomUUID()
      : `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`;
    localStorage.setItem(PUSH_INSTALLATION_KEY, id);
    return id;
  } catch {
    // Private mode / storage disabled — use one stable value for this session.
  }
  if (!ephemeralInstallationId) {
    ephemeralInstallationId = typeof crypto !== "undefined" && "randomUUID" in crypto
      ? crypto.randomUUID()
      : `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`;
  }
  return ephemeralInstallationId;
}
