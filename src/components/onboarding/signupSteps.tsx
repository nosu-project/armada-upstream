import { useMemo, useState } from "react";
import { Info, Waypoints } from "lucide-react";
import { generateSecretKey, getPublicKey, nip19 } from "nostr-tools";

import { ArmadaKey } from "@/components/brand/ArmadaCrest";
import { BlossomServerListEditor } from "@/components/BlossomServerListEditor";
import { RelayListEditor } from "@/components/RelayListEditor";
import { SetupListRow } from "@/components/SetupListRow";
import { Button } from "@/components/ui/button";
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from "@/components/ui/tooltip";

import type { SignupSetup } from "@/lib/signupLists";

/**
 * Shared account-creation parts for {@link SignupWizard} and {@link SignupDialog}:
 * key minting ({@link useSignupKey}) and the step bodies. Login, chrome and
 * step transitions stay with each consumer.
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


const SETUP_ROWS: { field: keyof SignupSetup; label: string; hint: string }[] = [
  { field: "home", label: "Home", hint: "Stores your profile, follows and settings." },
  { field: "dm", label: "Messages", hint: "Other apps deliver your direct messages here." },
  { field: "search", label: "Search", hint: "Used to find people and communities." },
  { field: "blossom", label: "Media", hint: "Your uploads go here. Links use the first server." },
  { field: "community", label: "Communities", hint: "Default relays for communities you create." },
  { field: "broadcast", label: "Broadcast", hint: "Extra relays your public profile is sent to." },
];

/**
 * An ⓘ that explains a heading. Opens on hover and on tap, since phones never
 * hover; drawn above the signup dialog's own layer (`z-[255]`).
 */
function InfoTip({ label, hint }: { label: string; hint: string }) {
  const [open, setOpen] = useState(false);
  return (
    <Tooltip open={open} onOpenChange={setOpen}>
      <TooltipTrigger asChild>
        <button
          type="button"
          aria-label={`About ${label}`}
          className="flex size-8 shrink-0 items-center justify-center text-muted-foreground hover:text-foreground touch:size-11"
          onClick={() => setOpen((prev) => !prev)}
        >
          <Info className="size-3.5" aria-hidden />
        </button>
      </TooltipTrigger>
      <TooltipContent side="top" className="z-[300] max-w-60">{hint}</TooltipContent>
    </Tooltip>
  );
}

/**
 * Step 2 body: every relay and media server list the new account starts with,
 * one row each with its first entry's status light. A row opens its editor
 * (one at a time); Continue accepts everything as listed.
 */
export function RelayStepBody({
  setup,
  defaults,
  onChange,
  onContinue,
}: {
  setup: SignupSetup;
  defaults: SignupSetup;
  onChange: (setup: SignupSetup) => void;
  onContinue: () => void;
}) {
  const [open, setOpen] = useState<keyof SignupSetup | null>(null);
  const set = (field: keyof SignupSetup) => (list: string[]) => onChange({ ...setup, [field]: list });
  return (
    <TooltipProvider delayDuration={300}>
      <div className="flex flex-col items-center gap-6 text-center">
        <Waypoints className="size-16 text-primary" aria-hidden />
        <div className="space-y-2">
          <div className="flex items-center justify-center gap-1">
            <h1 className="font-mono text-2xl font-bold lowercase tracking-tight text-foreground">
              your relays
            </h1>
            <InfoTip
              label="relays"
              hint="Relays are servers that store and pass along your profile, messages and lists. You can use any you like, and more than one."
            />
          </div>
          <p className="text-sm leading-relaxed text-muted-foreground">
            Armada picked these for you. Change any of them now or later in Settings.
          </p>
        </div>
        <div className="w-full clip-corner-lg bg-secondary/40 text-left divide-y divide-background/60">
          {SETUP_ROWS.map(({ field, label, hint }) => {
            const list = setup[field];
            return (
              <SetupListRow
                key={field}
                label={label}
                hint={hint}
                urls={list}
                kind={field === "blossom" ? "blossom" : "relay"}
                open={open === field}
                onOpenChange={(next) => setOpen(next ? field : null)}
              >
                {field === "blossom" ? (
                  <BlossomServerListEditor
                    servers={setup.blossom}
                    onChange={set("blossom")}
                    onReset={() => set("blossom")(defaults.blossom)}
                    emptyText="None. Uploads use Armada's servers."
                  />
                ) : (
                  <RelayListEditor
                    relays={list}
                    onChange={set(field)}
                    onReset={() => set(field)(defaults[field])}
                    emptyText={field === "home" ? "None. Continue uses the defaults." : "None."}
                  />
                )}
              </SetupListRow>
            );
          })}
        </div>
        <Button
          type="button"
          size="lg"
          className="h-12 w-full clip-corner-lg text-base font-medium"
          onClick={onContinue}
        >
          Continue
        </Button>
      </div>
    </TooltipProvider>
  );
}

/* Step 1 is {@link ProfileStepBody} in `./ProfileStep`. */
