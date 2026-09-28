/**
 * nsec credential helpers (ported from Ditto). A `null` result means unavailable.
 *
 * Native branches gate on `getPlatform() === "android"`, never
 * `isNativePlatform()`: the `ArmadaCredential` plugin is registered only in
 * MainActivity, so iOS would just reject.
 */

import { Capacitor, registerPlugin } from "@capacitor/core";

interface NsecCredential {
  npub: string;
  nsec: string;
}

/** Native Credential Manager bridge (Android). See ArmadaCredentialPlugin.java. */
interface ArmadaCredentialPlugin {
  /**
   * Save the nsec (keyed by npub) via the Android Credential Manager sheet.
   * Neither `saved` nor `cancelled` → no provider available.
   */
  saveCredential(options: { id: string; password: string }): Promise<{
    saved: boolean;
    cancelled: boolean;
    reason?: string;
  }>;
  /** Write a text file to public Downloads (blob downloads fail in the WebView). */
  saveToFile(options: { filename: string; content: string }): Promise<{ location: string }>;
}

const ArmadaCredential = registerPlugin<ArmadaCredentialPlugin>("ArmadaCredential");

export type KeyringResult = "saved" | "cancelled" | "unavailable";

/**
 * Store the nsec in the OS keyring / password manager, keyed by npub.
 * Android 14+ Credential Manager (no pre-34 provider bundled), or the browser
 * Credential Management API. `"unavailable"` = no keyring (Firefox/Safari, iOS,
 * older Android, no provider).
 */
export async function saveToKeyring(npub: string, nsec: string): Promise<KeyringResult> {
  if (Capacitor.getPlatform() === "android") {
    try {
      const { saved, cancelled, reason } = await ArmadaCredential.saveCredential({ id: npub, password: nsec });
      if (saved) return "saved";
      if (!cancelled && reason) console.warn("[credential] keyring save unavailable:", reason);
      return cancelled ? "cancelled" : "unavailable";
    } catch {
      // Older binary without the plugin, or the platform threw.
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

/** File System Access API "Save as…"; not in `lib.dom` and absent in Firefox/Safari. */
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
 * Save the key to the filesystem: "Save as…" dialog or plain download on web,
 * public Downloads on Android (MediaStore via plugin), Documents on iOS.
 * `"cancelled"` only for a dismissed save dialog.
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

  // iOS: Documents shows as the "Armada" folder in Files (UIFileSharingEnabled).
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
      // AbortError = user closed the dialog; anything else falls through to download.
      if (err instanceof DOMException && err.name === "AbortError") return { status: "cancelled" };
    }
  }

  downloadTextFile(KEY_FILENAME, nsec);
  return { status: "saved", location: `your downloads (${KEY_FILENAME})` };
}

export type ExportResult =
  | { status: "saved"; location: string }
  | { status: "cancelled" }
  | { status: "failed" };

/**
 * Back the key up during onboarding by a route the user can SEE happen:
 * Android's Credential Manager sheet, else a file. The web Credential API is
 * skipped because Chromium stores silently.
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

export async function getNsecCredential(): Promise<NsecCredential | null> {
  try {
    if (!("credentials" in navigator) || !window.PasswordCredential) return null;
    const cred = (await navigator.credentials.get({
      // `password` isn't in the TS lib types.
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
 * Save to the keyring, falling back to {@link exportNsec}. Onboarding uses
 * {@link backUpNsec} instead, to gate on a visible backup.
 */
export async function saveNsec(npub: string, nsec: string): Promise<void> {
  if ((await saveToKeyring(npub, nsec)) === "saved") return;
  await exportNsec(nsec);
}

/** Download a text file (web only). */
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
