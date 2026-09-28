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
 * Login-state storage for `NostrLoginProvider` (holds nsecs): OS keystore on
 * Capacitor (migrating legacy localStorage copies), safeStorage-encrypted
 * localStorage on desktop, plain localStorage on the web.
 */

/**
 * Desktop storage envelope. A stored value is one of:
 *   `[]`                                   — signed out; plaintext by design
 *   `{"v":1,"enc":"safeStorage","data":…}` — signed in, encrypted at rest
 *   `[{…}]`                                — signed in, plaintext (legacy / no encryption)
 * `[]` must stay plaintext: the boot script in `index.html` tests `!== "[]"`
 * synchronously to decide whether to draw the splash crest.
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
    // Plaintext: upgrade in place only if encryption succeeds.
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

  // Undecryptable (store reset, profile copied, old shell): likely the only copy
  // of the user's key, and the signed-out UI's next write would overwrite it —
  // park it first, keeping the earliest parked copy.
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
    // No credential store: fall back to plaintext rather than break login.
    localStorage.setItem(key, value);
    return;
  }

  const envelope: SecretEnvelope = { v: 1, enc: "safeStorage", data: ciphertext };
  localStorage.setItem(key, JSON.stringify(envelope));
}

export const secureStorage: NLoginStorage = {
  async getItem(key: string): Promise<string | null> {
    // NostrLoginProvider renders nothing until this resolves, so it's on the boot critical path.
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
