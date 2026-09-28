import { useSyncExternalStore } from "react";

import {
  getDecryptConsentSnapshot,
  resetDecryptConsent,
  setDecryptConsent,
  subscribeDecryptConsent,
  type DecryptConsentState,
} from "@/lib/decryptConsent";

/**
 * The app-wide bulk-decrypt consent decision (`@/lib/decryptConsent`), reactive
 * across surfaces and tabs.
 */
export function useDecryptConsent(): {
  /** `"allowed" | "declined"`, or `null` when the user hasn't decided yet. */
  consent: DecryptConsentState;
  /** Whether the user has explicitly declined bulk decryption. */
  declined: boolean;
  /** Grant consent (persisted, resolves any pending prompt). */
  allow: () => void;
  /** Decline consent (persisted, surfaces the manual decrypt affordances). */
  decline: () => void;
  /** Forget the decision (re-prompts next time). */
  reset: () => void;
} {
  const consent = useSyncExternalStore(subscribeDecryptConsent, getDecryptConsentSnapshot, getDecryptConsentSnapshot);
  return {
    consent,
    declined: consent === "declined",
    allow: () => setDecryptConsent("allowed"),
    decline: () => setDecryptConsent("declined"),
    reset: resetDecryptConsent,
  };
}
