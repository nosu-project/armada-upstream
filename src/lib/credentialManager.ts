/**
 * Web-only credential helpers for the nsec key, ported (and de-Capacitor-ed)
 * from Ditto's credentialManager.
 *
 * Uses the Credential Management API where available (Chromium) so the
 * browser's password manager can store/offer the key. Always falls back
 * gracefully — callers must treat a `null` result as "not available".
 */

import { Capacitor, registerPlugin } from "@capacitor/core";

interface NsecCredential {
  npub: string;
  nsec: string;
}

/** Native Credential Manager bridge (Android). See ArmadaCredentialPlugin.java. */
interface ArmadaCredentialPlugin {
  /**
   * Save a password credential (the nsec, keyed by npub) via the Android
   * Credential Manager's system sheet. Resolves `{ saved, cancelled }` rather
   * than rejecting: `saved` → stored; `cancelled` → the user dismissed the
   * sheet; neither → no provider available (caller should export another way).
   */
  saveCredential(options: { id: string; password: string }): Promise<{
    saved: boolean;
    cancelled: boolean;
    reason?: string;
  }>;
  /**
   * Write a text file to the device's public Downloads folder (blob downloads
   * don't work in the Android WebView). Resolves the human-readable location.
   */
  saveToFile(options: { filename: string; content: string }): Promise<{ location: string }>;
}

const ArmadaCredential = registerPlugin<ArmadaCredentialPlugin>("ArmadaCredential");

/** Outcome of an attempt to store the key in the OS keyring / password manager. */
export type KeyringResult = "saved" | "cancelled" | "unavailable";

/**
 * Store the nsec in the OS keyring / password manager, keyed by npub.
 *
 * Native: the Android Credential Manager's biometric-gated "Save password?"
 * sheet (real, recoverable, cross-device backup). Web/desktop: the browser
 * Credential Management API (Chromium's password manager). Returns which
 * happened so the caller can decide whether to proceed, wait, or fall back to
 * exporting the key file — `"unavailable"` means there's no keyring to save to
 * (e.g. Firefox/Safari, or an Android device with no credential provider).
 */
export async function saveToKeyring(npub: string, nsec: string): Promise<KeyringResult> {
  if (Capacitor.isNativePlatform()) {
    try {
      const { saved, cancelled, reason } = await ArmadaCredential.saveCredential({ id: npub, password: nsec });
      if (saved) return "saved";
      if (!cancelled && reason) console.warn("[credential] keyring save unavailable:", reason);
      return cancelled ? "cancelled" : "unavailable";
    } catch {
      // Older app binary without the plugin, or the platform threw: no keyring.
      return "unavailable";
    }
  }
  try {
    if ("credentials" in navigator && window.PasswordCredential) {
      const cred = new window.PasswordCredential({ id: npub, password: nsec, name: "Nostr secret key" });
      await navigator.credentials.store(cred);
      return "saved";
    }
  } catch {
    return "unavailable";
  }
  return "unavailable";
}

/** Filename for the exported key file. */
const KEY_FILENAME = "armada-secret-key.txt";

/**
 * Save the key to the FILESYSTEM when the keyring isn't an option: a browser
 * download on web, a real file in the public Downloads folder on native (blob
 * downloads don't work in the Android WebView, so the native plugin writes the
 * file via MediaStore). Returns the human-readable location for a confirmation
 * message, or `null` if the write failed.
 */
export async function exportNsec(nsec: string): Promise<string | null> {
  if (Capacitor.isNativePlatform()) {
    try {
      const { location } = await ArmadaCredential.saveToFile({ filename: KEY_FILENAME, content: nsec });
      return location;
    } catch {
      return null;
    }
  }
  downloadTextFile(KEY_FILENAME, nsec);
  return KEY_FILENAME;
}

interface PasswordCredentialData {
  id: string;
  password: string;
  name?: string;
}

interface PasswordCredentialLike extends Credential {
  password?: string;
}

declare global {
  interface Window {
    PasswordCredential?: new (data: PasswordCredentialData) => Credential;
  }
}

/** Attempt to retrieve a stored nsec from the browser's credential manager. */
export async function getNsecCredential(): Promise<NsecCredential | null> {
  try {
    if (!("credentials" in navigator) || !window.PasswordCredential) return null;
    const cred = (await navigator.credentials.get({
      // `password` is a Credential Management API extension not in the TS lib types.
      ...({ password: true } as object),
      mediation: "optional",
    })) as PasswordCredentialLike | null;
    if (cred?.password && cred.password.startsWith("nsec1")) {
      return { npub: cred.id, nsec: cred.password };
    }
    return null;
  } catch {
    return null;
  }
}

/**
 * Save the nsec to the OS keyring / password manager, falling back to a file
 * download (web) or the share sheet (native) when there's no keyring or the
 * user dismisses it. Fire-and-forget helper for callers that don't need to
 * distinguish the outcome; onboarding uses {@link saveToKeyring} directly so it
 * can gate on an explicit save.
 */
export async function saveNsec(npub: string, nsec: string): Promise<void> {
  if ((await saveToKeyring(npub, nsec)) === "saved") return;
  await exportNsec(nsec);
}

/** Download a text file (web only — Armada has no native wrapper). */
export function downloadTextFile(filename: string, content: string): void {
  const blob = new Blob([content], { type: "text/plain" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  URL.revokeObjectURL(url);
}
