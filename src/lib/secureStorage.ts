import { Capacitor } from "@capacitor/core";
import { SecureStoragePlugin } from "capacitor-secure-storage-plugin";

import {
  desktopDecryptSecret,
  desktopEncryptSecret,
  isDesktop,
} from "@/lib/desktop";
import { perfMark } from "@/lib/perf";

import type { NLoginStorage } from "@nostrify/react/login";

/**
 * Login-state storage adapter for `NostrLoginProvider`: native secure storage
 * (iOS Keychain / Android KeyStore) on Capacitor builds, OS-encrypted
 * localStorage in the desktop shell, and plain `localStorage` on the web.
 *
 * The login store holds the nsec for key logins, so on native it must live in
 * the OS keystore. WebView `localStorage` is plaintext and can be evicted by
 * the OS under storage pressure (losing the session entirely). On the first
 * native read, a legacy plaintext `localStorage` copy is migrated into secure
 * storage and removed.
 *
 * Desktop (Electron) has no keystore plugin but does have `safeStorage`, which
 * wraps the OS credential store. There the value STAYS in localStorage and the
 * ciphertext is what's stored — see the envelope notes below. Plain browsers
 * have nowhere better to put it, so the web path is unchanged.
 */

/**
 * Desktop storage envelope. A stored value is one of:
 *
 *   `[]`                                  — signed out; plaintext by design
 *   `{"v":1,"enc":"safeStorage","data":…}` — signed in, encrypted at rest
 *   `[{…}]`                                — signed in, plaintext (legacy, or
 *                                            encryption unavailable)
 *
 * An empty list stays plaintext on purpose: there is nothing secret in it, and
 * the inline boot script in `index.html` reads this key synchronously (testing
 * `!== "[]"`) to decide whether to draw the crest before the bundle parses. An
 * envelope around an empty list would read as "signed in" and animate a splash
 * for a signed-out launch.
 */
interface SecretEnvelope {
  v: 1;
  enc: "safeStorage";
  data: string;
}

/** Where an undecryptable blob is parked so a later write can't destroy it. */
const lockedKey = (key: string) => `${key}-locked`;

function parseEnvelope(raw: string): SecretEnvelope | null {
  try {
    const parsed: unknown = JSON.parse(raw);
    if (
      parsed && typeof parsed === "object" && !Array.isArray(parsed) &&
      (parsed as SecretEnvelope).enc === "safeStorage" &&
      typeof (parsed as SecretEnvelope).data === "string"
    ) {
      return parsed as SecretEnvelope;
    }
  } catch {
    // Not JSON — treat as opaque plaintext.
  }
  return null;
}

/** True for a value that holds no logins, and so needs no encryption. */
function isEmptyList(value: string): boolean {
  try {
    const parsed: unknown = JSON.parse(value);
    return Array.isArray(parsed) && parsed.length === 0;
  } catch {
    return false;
  }
}

async function desktopGetItem(key: string): Promise<string | null> {
  const raw = localStorage.getItem(key);
  if (raw === null) {
    perfMark("login.read done", "absent");
    return null;
  }

  const envelope = parseEnvelope(raw);
  if (!envelope) {
    // Plaintext: either a pre-encryption install or a write made while the
    // credential store was unavailable. Upgrade it in place, but only once we
    // know we can read it back — a failed encrypt leaves the plaintext alone.
    if (!isEmptyList(raw)) {
      const ciphertext = await desktopEncryptSecret(raw);
      if (ciphertext) {
        const migrated: SecretEnvelope = { v: 1, enc: "safeStorage", data: ciphertext };
        localStorage.setItem(key, JSON.stringify(migrated));
        perfMark("login.read done", "migrated to safeStorage");
        return raw;
      }
    }
    perfMark("login.read done", "localStorage (plaintext)");
    return raw;
  }

  const plaintext = await desktopDecryptSecret(envelope.data);
  if (plaintext !== null) {
    perfMark("login.read done", "safeStorage");
    return plaintext;
  }

  // Locked, NOT empty: the credential store was reset, the profile was copied
  // to another machine, or the shell predates the bridge. This blob is very
  // likely the only copy of the user's identity key, and the app is about to
  // show a signed-out UI whose next write would overwrite it — so park a copy
  // first. Only if one isn't parked already: the first failure holds the key
  // that a subsequent fresh login replaces.
  try {
    if (localStorage.getItem(lockedKey(key)) === null) {
      localStorage.setItem(lockedKey(key), raw);
    }
  } catch {
    // best-effort
  }
  perfMark("login.read done", "locked");
  return null;
}

async function desktopSetItem(key: string, value: string): Promise<void> {
  if (isEmptyList(value)) {
    localStorage.setItem(key, value);
    return;
  }

  const ciphertext = await desktopEncryptSecret(value);
  if (!ciphertext) {
    // No credential store (or an older shell). Storing plaintext is exactly
    // today's behavior; refusing the write would break login instead.
    localStorage.setItem(key, value);
    return;
  }

  const envelope: SecretEnvelope = { v: 1, enc: "safeStorage", data: ciphertext };
  localStorage.setItem(key, JSON.stringify(envelope));
}

export const secureStorage: NLoginStorage = {
  async getItem(key: string): Promise<string | null> {
    // `NostrLoginProvider` renders its `fallback` (unset here, so NOTHING) until
    // this resolves — no pool, no sockets, no queries, not even the route chunk
    // request. It is strictly first, so it gets a milestone at both ends.
    perfMark("login.read start", key);
    if (!Capacitor.isNativePlatform()) {
      if (isDesktop()) return desktopGetItem(key);
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
      if (isDesktop()) return desktopSetItem(key, value);
      localStorage.setItem(key, value);
      return;
    }

    await SecureStoragePlugin.set({ key, value });
  },
};
