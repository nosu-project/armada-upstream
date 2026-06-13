/**
 * Web-only credential helpers for the nsec key, ported (and de-Capacitor-ed)
 * from Ditto's credentialManager.
 *
 * Uses the Credential Management API where available (Chromium) so the
 * browser's password manager can store/offer the key. Always falls back
 * gracefully — callers must treat a `null` result as "not available".
 */

interface NsecCredential {
  npub: string;
  nsec: string;
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

/** Save the nsec to the browser's credential manager; falls back to a file download. */
export async function saveNsec(npub: string, nsec: string): Promise<void> {
  try {
    if ("credentials" in navigator && window.PasswordCredential) {
      const cred = new window.PasswordCredential({
        id: npub,
        password: nsec,
        name: "Nostr secret key",
      });
      await navigator.credentials.store(cred);
      return;
    }
  } catch {
    // fall through to download
  }
  downloadTextFile("secret-key.txt", nsec);
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
