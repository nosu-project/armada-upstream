import { Capacitor } from "@capacitor/core";

import { LOGIN_STORAGE_KEY } from "@/lib/switchAccount";

/**
 * Cheap, synchronous guess at whether this launch is signed in (mirrors
 * `public/boot-splash.js`; native assumes yes). Only used to start a fetch
 * early — never branch on it for correctness.
 */
export function likelySignedIn(): boolean {
  try {
    if (Capacitor.isNativePlatform()) return true;
    const login = localStorage.getItem(LOGIN_STORAGE_KEY);
    return !!login && login !== "[]";
  } catch {
    // Storage blocked: guessing "signed in" only prefetches the heavier path.
    return true;
  }
}
