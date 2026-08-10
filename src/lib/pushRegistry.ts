/**
 * The device-local bookkeeping every nostr-push controller keeps.
 *
 * Shared by `useNostrPush` (Web Push) and `useIosPush` (APNs) — one device runs
 * only one of them, so they are the same three facts under the same three keys
 * rather than a per-platform copy that could disagree about what "on" means:
 *
 *  - the user's INTENT, which is not the same as the OS permission. Intent is
 *    opt-out and survives a revoked-then-regranted permission, so returning to
 *    the app repairs push instead of silently leaving it off.
 *  - the per-type prefs, which are account-global and shared with the Android
 *    service and the in-app notifier too (see `pushPrefs.ts`).
 *  - the subscription ids last registered with the gateway. Registrations are
 *    SERVER-side and outlive the process, so this is the only durable record of
 *    what needs pruning when the watch set shrinks — and, on a cold start, the
 *    only way to tell "nothing to watch yet" from "was watching, now nothing".
 */

import { type PushPrefs } from "@/lib/pushPrefs";

const INTENT_KEY = "armada:push-intent";
const PREFS_KEY = "armada:push-prefs";
const SUBS_KEY = "armada:nostr-push-subs";

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

export function savePushPrefs(prefs: PushPrefs): void {
  try {
    localStorage.setItem(PREFS_KEY, JSON.stringify(prefs));
  } catch {
    // ignore
  }
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
    localStorage.setItem(SUBS_KEY, JSON.stringify(ids));
  } catch {
    // ignore
  }
}
