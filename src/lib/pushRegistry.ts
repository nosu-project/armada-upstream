/**
 * The device-local bookkeeping every push controller keeps.
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
 */

import {
  savePushPrefs as saveAccountPushPrefs,
  type PushPrefs,
} from "@/lib/pushPrefs";

const INTENT_KEY = "armada:push-intent";

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
