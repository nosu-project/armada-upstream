/**
 * Credential helpers for the nsec key, ported from Ditto's credentialManager.
 *
 * Uses the Credential Management API where available (Chromium) so the
 * browser's password manager can store/offer the key. Always falls back
 * gracefully — callers must treat a `null` result as "not available".
 *
 * Every native branch here gates on `getPlatform() === "android"`, never on
 * `isNativePlatform()`: the `ArmadaCredential` plugin is registered only in
 * MainActivity, so an `isNativePlatform()` gate sends iOS into a call that can
 * only reject. iOS takes the web path or an explicit iOS branch instead.
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
 * Android: the Credential Manager's biometric-gated "Save password?" sheet
 * (real, recoverable, cross-device backup), on Android 14+ only — Armada
 * doesn't bundle Google's pre-34 provider (see ArmadaCredentialPlugin). Web/
 * desktop: the browser Credential Management API (Chromium's password manager).
 * Returns which happened so the caller can decide whether to proceed, wait, or
 * fall back to exporting the key file — `"unavailable"` means there's no
 * keyring to save to (Firefox/Safari, iOS, an Android below 14, or an Android
 * 14+ device with no credential provider configured).
 *
 * The native check is for ANDROID specifically, not for native: `ArmadaCredential`
 * is registered only in MainActivity, so on iOS the call rejects. iOS falls
 * through to the web branch, where WebKit has no `PasswordCredential` and the
 * answer is the same `"unavailable"` — without a rejected promise on the way.
 */
export async function saveToKeyring(npub: string, nsec: string): Promise<KeyringResult> {
  if (Capacitor.getPlatform() === "android") {
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
 * `showSaveFilePicker` — the File System Access API's "Save as…" dialog. Not
 * in `lib.dom`, and absent in Firefox/Safari, so it's declared and probed.
 */
interface SaveFilePicker {
  (options?: {
    suggestedName?: string;
    types?: Array<{ description?: string; accept: Record<string, string[]> }>;
  }): Promise<{
    name: string;
    createWritable(): Promise<{ write(data: string): Promise<void>; close(): Promise<void> }>;
  }>;
}

/**
 * Save the key to the FILESYSTEM: a real "Save as…" dialog where the browser
 * has one, a plain download where it doesn't, the public Downloads folder on
 * Android, and the app's Documents directory on iOS.
 *
 * Neither WebView can do the `<a download>` blob trick (see downloadFile.ts),
 * so both native platforms need a real write — Android through MediaStore via
 * the ArmadaCredential plugin, iOS through @capacitor/filesystem. Gating this
 * on `isNativePlatform()` instead of the platform NAME is what made iOS return
 * `"failed"` here: `ArmadaCredential` is registered only in MainActivity, so
 * the call rejected and onboarding's key backup had no route left.
 *
 * `"cancelled"` is only ever returned for a save dialog the user dismissed —
 * a plain download has no dialog to dismiss, so it reports `"saved"`.
 */
export async function exportNsec(nsec: string): Promise<ExportResult> {
  if (Capacitor.getPlatform() === "android") {
    try {
      const { location } = await ArmadaCredential.saveToFile({ filename: KEY_FILENAME, content: nsec });
      return { status: "saved", location };
    } catch {
      return { status: "failed" };
    }
  }

  // iOS: Documents is surfaced to the user as the "Armada" folder in the Files
  // app (LSSupportsOpeningDocumentsInPlace + UIFileSharingEnabled in
  // Info.plist), so the key lands somewhere they can find it and move it into a
  // password manager — which is what makes the returned location honest.
  if (Capacitor.isNativePlatform()) {
    try {
      const { Filesystem, Directory, Encoding } = await import("@capacitor/filesystem");
      await Filesystem.writeFile({
        path: KEY_FILENAME,
        data: nsec,
        directory: Directory.Documents,
        encoding: Encoding.UTF8,
      });
      return { status: "saved", location: `the Armada folder in Files (${KEY_FILENAME})` };
    } catch {
      return { status: "failed" };
    }
  }

  const picker = (window as unknown as { showSaveFilePicker?: SaveFilePicker }).showSaveFilePicker;
  if (picker) {
    try {
      const handle = await picker({
        suggestedName: KEY_FILENAME,
        types: [{ description: "Text file", accept: { "text/plain": [".txt"] } }],
      });
      const writable = await handle.createWritable();
      await writable.write(nsec);
      await writable.close();
      return { status: "saved", location: handle.name };
    } catch (err) {
      // AbortError is the user closing the dialog — a real "no". Anything else
      // (a sandboxed frame, a blocked permission, a write failure) is the
      // picker being unusable here, so fall through to the plain download.
      if (err instanceof DOMException && err.name === "AbortError") return { status: "cancelled" };
    }
  }

  downloadTextFile(KEY_FILENAME, nsec);
  return { status: "saved", location: `your downloads (${KEY_FILENAME})` };
}

/** Outcome of a key export / backup attempt. */
export type ExportResult =
  | { status: "saved"; location: string }
  | { status: "cancelled" }
  | { status: "failed" };

/**
 * Back the key up during onboarding, by whatever route the platform can SHOW
 * the user happening.
 *
 * Android gets the Credential Manager sheet first: it's a visible, biometric-
 * gated, syncing backup, and the user watches it appear. The web
 * Credential Management API is deliberately not used here — Chromium stores
 * silently, so a "saved to your password manager" confirmation names a place
 * the user never saw and may not have. On web the file dialog IS the
 * confirmation, and on iOS the file in Files is.
 */
export async function backUpNsec(npub: string, nsec: string): Promise<ExportResult> {
  if (Capacitor.getPlatform() === "android") {
    const result = await saveToKeyring(npub, nsec);
    if (result === "saved") return { status: "saved", location: "your password manager" };
    if (result === "cancelled") return { status: "cancelled" };
  }
  return exportNsec(nsec);
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
 * Save the nsec to the OS keyring / password manager, falling back to
 * {@link exportNsec} when there's no keyring or the user dismisses it.
 * Fire-and-forget helper for callers that don't need to distinguish the
 * outcome; onboarding uses {@link backUpNsec} so it can gate on a backup the
 * user actually saw happen.
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
