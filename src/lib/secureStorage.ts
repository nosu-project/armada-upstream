import { Capacitor } from "@capacitor/core";
import { SecureStoragePlugin } from "capacitor-secure-storage-plugin";

import { perfMark } from "@/lib/perf";

import type { NLoginStorage } from "@nostrify/react/login";

/**
 * Login-state storage adapter for `NostrLoginProvider`: native secure storage
 * (iOS Keychain / Android KeyStore) on Capacitor builds, `localStorage` on the
 * web.
 *
 * The login store holds the nsec for key logins, so on native it must live in
 * the OS keystore. WebView `localStorage` is plaintext and can be evicted by
 * the OS under storage pressure (losing the session entirely). On the first
 * native read, a legacy plaintext `localStorage` copy is migrated into secure
 * storage and removed.
 */
export const secureStorage: NLoginStorage = {
  async getItem(key: string): Promise<string | null> {
    // `NostrLoginProvider` renders its `fallback` (unset here, so NOTHING) until
    // this resolves — no pool, no sockets, no queries, not even the route chunk
    // request. It is strictly first, so it gets a milestone at both ends.
    perfMark("login.read start", key);
    if (!Capacitor.isNativePlatform()) {
      const web = localStorage.getItem(key);
      perfMark("login.read done", "localStorage");
      return web;
    }

    try {
      const { value } = await SecureStoragePlugin.get({ key });
      perfMark("login.read done", "secure storage");
      return value;
    } catch {
      // Key not found in secure storage; check localStorage for migration.
      const legacy = localStorage.getItem(key);
      if (legacy !== null) {
        // Migrate to secure storage and remove the plaintext copy.
        await SecureStoragePlugin.set({ key, value: legacy });
        localStorage.removeItem(key);
        perfMark("login.read done", "migrated from localStorage");
        return legacy;
      }
      perfMark("login.read done", "absent");
      return null;
    }
  },

  async setItem(key: string, value: string): Promise<void> {
    if (!Capacitor.isNativePlatform()) {
      localStorage.setItem(key, value);
      return;
    }

    await SecureStoragePlugin.set({ key, value });
  },
};
