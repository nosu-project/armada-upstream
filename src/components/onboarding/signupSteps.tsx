import { useMemo, useState } from "react";
import { generateSecretKey, getPublicKey, nip19 } from "nostr-tools";

import { ArmadaKey } from "@/components/brand/ArmadaCrest";
import { Button } from "@/components/ui/button";

/**
 * Shared account-creation parts for {@link SignupWizard} and {@link SignupDialog}:
 * key minting ({@link useSignupKey}) and the creating step. Login, chrome and
 * step transitions stay with each consumer. A new account starts on the default
 * relays (`defaultSignupSetup`); they're changed in Settings, not here.
 */

export interface SignupKey {
  nsec: string;
  identity: { pubkey: string; npub: string } | null;
  /** Mint a fresh key (the dialog reuses one instance) and return it. */
  reset: () => string;
}

const mintNsec = () => nip19.nsecEncode(generateSecretKey());

export function signupIdentity(nsec: string): SignupKey["identity"] {
  try {
    const decoded = nip19.decode(nsec);
    if (decoded.type !== "nsec") return null;
    const pubkey = getPublicKey(decoded.data);
    return { pubkey, npub: nip19.npubEncode(pubkey) };
  } catch {
    return null;
  }
}

/**
 * Mints the key on mount. Signup logs in with it straight away; backing it up
 * is asked for later (`lib/keyBackup.ts`, `KeyBackupReminder`).
 */
export function useSignupKey(): SignupKey {
  const [nsec, setNsec] = useState(mintNsec);
  const identity = useMemo(() => signupIdentity(nsec), [nsec]);

  const reset = () => {
    const next = mintNsec();
    setNsec(next);
    return next;
  };

  return { nsec, identity, reset };
}

/**
 * Step 0: the account is being created (login with the minted key). Only stays
 * up for the login's persist, or to offer a retry when it fails.
 */
export function CreatingAccountStepBody({ failed, onRetry }: { failed: boolean; onRetry: () => void }) {
  return (
    <div className="flex flex-col items-center gap-6 text-center">
      <ArmadaKey size={96} />
      <div className="space-y-2">
        <h1 className="font-mono text-2xl font-bold lowercase tracking-tight text-foreground">
          {failed ? "couldn't create your account" : "creating your account…"}
        </h1>
        {failed && (
          <p className="text-sm leading-relaxed text-muted-foreground">
            It couldn't be saved to this device. Nothing was lost; try again.
          </p>
        )}
      </div>
      {failed && (
        <Button
          type="button"
          size="lg"
          className="h-12 w-full clip-corner-lg text-base font-medium"
          onClick={onRetry}
        >
          Try again
        </Button>
      )}
    </div>
  );
}

/* The one step after it is {@link ProfileStepBody} in `./ProfileStep`. */
