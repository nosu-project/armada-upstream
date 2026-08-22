import { Capacitor } from "@capacitor/core";

import { LOGIN_STORAGE_KEY } from "@/lib/switchAccount";

/**
 * Does this launch look like a signed-in one, cheaply enough to ask at module
 * scope — before the provider tree mounts and long before the real login state
 * has been read out of storage?
 *
 * The same question, and the same two answers, as `public/boot-splash.js`: on
 * the web the session is a localStorage entry readable synchronously, while
 * native keeps it in the OS keystore, so being native stands in for "assume
 * signed in" (which is right in the case that matters — a native cold start
 * is overwhelmingly a returning user).
 *
 * This is ONLY ever used to start a fetch early. A wrong answer costs one
 * speculative chunk request, never correctness: nothing branches on it, and
 * every consumer still gates its actual render on the real `useCurrentUser`.
 * Don't grow a second responsibility onto it — the authoritative read is
 * async, and this one is a guess by construction.
 */
export function likelySignedIn(): boolean {
  try {
    if (Capacitor.isNativePlatform()) return true;
    const login = localStorage.getItem(LOGIN_STORAGE_KEY);
    return !!login && login !== "[]";
  } catch {
    // Storage blocked (private mode, embedded webview). Guessing "signed in"
    // only ever pre-fetches the app frame, which is the heavier of the two
    // paths and therefore the better guess to be wrong about.
    return true;
  }
}
