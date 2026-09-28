/**
 * The single app-wide consent gate for bulk signer decryption, preventing a
 * "decrypt storm" of per-decrypt bunker/extension prompts on cold load.
 *
 *   - unset    → the first uncached decrypt opens ONE prompt all callers share.
 *   - allowed  → decrypts proceed everywhere.
 *   - declined → bulk decrypts refused; UI offers manual "Decrypt" affordances.
 *
 * Persisted in localStorage, app-wide (it's about the signer, not a room).
 * Callers gate only the uncached remainder; fully cached sets skip the gate.
 */

const STORAGE_KEY = "armada:decrypt-consent";

/** The persisted decision. `null` means "not yet decided". */
export type DecryptConsent = "allowed" | "declined";
export type DecryptConsentState = DecryptConsent | null;

type Listener = () => void;

const listeners = new Set<Listener>();

let current: DecryptConsentState = readPersisted();

let pending: Promise<DecryptConsent> | null = null;

/**
 * The app-wide dialog's opener; it must eventually call `resolveConsentPrompt`.
 * Without one, an unset gate resolves to "declined" (never blocks or storms).
 */
let openPrompt: (() => void) | null = null;

function readPersisted(): DecryptConsentState {
  try {
    const v = localStorage.getItem(STORAGE_KEY);
    return v === "allowed" || v === "declined" ? v : null;
  } catch {
    return null;
  }
}

function emit(): void {
  for (const l of listeners) l();
}

/** Current decision (synchronous). `null` when undecided. */
export function getDecryptConsent(): DecryptConsentState {
  return current;
}

/** Persist and broadcast a decision. Resolves any in-flight prompt. */
export function setDecryptConsent(value: DecryptConsent): void {
  current = value;
  try {
    localStorage.setItem(STORAGE_KEY, value);
  } catch {
    // best-effort; the in-memory value still governs this session
  }
  resolveConsentPrompt(value);
  emit();
}

/** Forget the decision (used on logout). The next need re-prompts. */
export function resetDecryptConsent(): void {
  current = null;
  try {
    localStorage.removeItem(STORAGE_KEY);
  } catch {
    // ignore
  }
  emit();
}

/**
 * The standing decision, opening the one-time prompt when undecided; concurrent
 * callers share one promise. No opener → "declined".
 */
export function ensureDecryptConsent(): Promise<DecryptConsent> {
  if (current) return Promise.resolve(current);
  if (pending) return pending;

  const promise = new Promise<DecryptConsent>((resolve) => {
    resolvePending = resolve;
  });
  pending = promise;

  if (openPrompt) {
    openPrompt();
  } else {
    // No UI: decline. This clears `pending`, so return the captured promise.
    resolveConsentPrompt("declined");
  }
  return promise;
}

let resolvePending: ((value: DecryptConsent) => void) | null = null;

/**
 * Resolve the in-flight prompt. Only `setDecryptConsent` persists; a bare
 * "declined" fallback doesn't, so the user is asked when a dialog exists.
 */
export function resolveConsentPrompt(value: DecryptConsent): void {
  resolvePending?.(value);
  resolvePending = null;
  pending = null;
}

/** Whether a prompt is currently pending (drives the dialog's open state). */
export function isConsentPromptPending(): boolean {
  return pending !== null;
}

/** Register the dialog's opener (opens immediately if a prompt is pending). Returns an unsubscribe. */
export function registerConsentPromptOpener(opener: () => void): () => void {
  openPrompt = opener;
  if (pending) opener();
  return () => {
    if (openPrompt === opener) openPrompt = null;
  };
}

export function subscribeDecryptConsent(listener: Listener): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

export function getDecryptConsentSnapshot(): DecryptConsentState {
  return current;
}

/** Test seam: fully reset module state (decision, pending prompt, opener). */
export function __resetDecryptConsentForTests(): void {
  resetDecryptConsent();
  resolvePending = null;
  pending = null;
  openPrompt = null;
}
