import { useMemo, useState, type Dispatch, type SetStateAction } from "react";
import { AlertTriangle, Check, ChevronDown, Copy, Download, Eye, Info, Waypoints } from "lucide-react";
import { generateSecretKey, getPublicKey, nip19 } from "nostr-tools";

import { ArmadaKey } from "@/components/brand/ArmadaCrest";
import { BlossomServerListEditor } from "@/components/BlossomServerListEditor";
import { RelayListEditor } from "@/components/RelayListEditor";
import { Button } from "@/components/ui/button";
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "@/components/ui/collapsible";
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from "@/components/ui/tooltip";
import { BlossomLed, RelayLed } from "@/components/RelayLed";
import { Input } from "@/components/ui/input";
import { toast } from "@/hooks/useToast";
import { writeClipboardText } from "@/lib/clipboard";
import { backUpNsec } from "@/lib/credentialManager";
import { cn } from "@/lib/utils";

import type { SignupSetup } from "@/lib/signupLists";

/**
 * Shared account-creation parts for {@link SignupWizard} and {@link SignupDialog}:
 * key minting, the backup gate ({@link useSignupKey}) and the key and relay step bodies.
 * Login, chrome and step transitions stay with each consumer.
 */

export interface SignupKey {
  nsec: string;
  identity: { pubkey: string; npub: string } | null;
  showKey: boolean;
  setShowKey: Dispatch<SetStateAction<boolean>>;
  copied: boolean;
  saving: boolean;
  /** True once the key has demonstrably left the screen (Copy, keyring save, or export); reveals Continue. */
  backedUp: boolean;
  copyKey: () => Promise<void>;
  saveKey: () => Promise<void>;
  /** Start over with a fresh, un-backed-up key (the dialog reuses one instance). */
  reset: () => void;
}

const mintNsec = () => nip19.nsecEncode(generateSecretKey());

/** Mints the key on mount: it stays on this device until a login uses it. */
export function useSignupKey(): SignupKey {
  const [nsec, setNsec] = useState(mintNsec);
  const [showKey, setShowKey] = useState(false);
  const [copied, setCopied] = useState(false);
  const [saving, setSaving] = useState(false);
  const [backedUp, setBackedUp] = useState(false);

  const identity = useMemo(() => {
    if (!nsec) return null;
    try {
      const decoded = nip19.decode(nsec);
      if (decoded.type !== "nsec") return null;
      const pubkey = getPublicKey(decoded.data);
      return { pubkey, npub: nip19.npubEncode(pubkey) };
    } catch {
      return null;
    }
  }, [nsec]);

  const reset = () => {
    setNsec(mintNsec());
    setShowKey(false);
    setCopied(false);
    setSaving(false);
    setBackedUp(false);
  };

  const copyKey = async () => {
    try {
      await writeClipboardText(nsec);
      setCopied(true);
      setBackedUp(true);
      setTimeout(() => setCopied(false), 2000);
    } catch {
      toast({
        title: "Copy failed",
        description: "Could not copy to the clipboard. Please select and copy it manually.",
        variant: "destructive",
      });
    }
  };

  // "Save as…" on web, Credential Manager on native. Doesn't advance; a dismissed dialog changes nothing.
  const saveKey = async () => {
    if (saving) return;
    if (!identity) {
      toast({
        title: "Invalid key",
        description: "That key is invalid. Please generate a new one.",
        variant: "destructive",
      });
      return;
    }

    setSaving(true);
    try {
      const result = await backUpNsec(identity.npub, nsec);
      if (result.status === "cancelled") {
        toast({
          title: "Key not saved",
          description:
            "Save the file or copy the key before continuing. It's your only login.",
        });
        return;
      }
      if (result.status === "failed") {
        toast({
          title: "Couldn't save your key",
          description:
            "Saving failed. Reveal your key, copy it, and store it somewhere safe, then continue.",
          variant: "destructive",
        });
        return;
      }
      setBackedUp(true);
      toast({
        title: "Key saved",
        description: `Saved to ${result.location}. Keep it safe. It's your only login.`,
      });
    } finally {
      setSaving(false);
    }
  };

  return {
    nsec,
    identity,
    showKey,
    setShowKey,
    copied,
    saving,
    backedUp,
    copyKey,
    saveKey,
    reset,
  };
}

/**
 * Step 1 body: back up the already-minted key. Continue is ABSENT (not disabled)
 * until backed up, with its space reserved so nothing moves when it fades in.
 * ToS is a plain anchor: a mid-wizard route change isn't safe, and /terms exists everywhere.
 */
export function SaveKeyStepBody({
  signupKey,
  loggingIn,
  onContinue,
}: {
  signupKey: SignupKey;
  loggingIn: boolean;
  onContinue: () => void;
}) {
  const { nsec, showKey, setShowKey, copied, saving, backedUp, copyKey, saveKey } = signupKey;
  return (
    <div className="flex flex-col items-center gap-6 text-center">
      <ArmadaKey size={96} />
      <div className="space-y-2">
        <h1 className="font-mono text-2xl font-bold lowercase tracking-tight text-foreground">
          save your secret key
        </h1>
        <p className="text-sm leading-relaxed text-muted-foreground">
          This key is your account. There's no email or password.
        </p>
      </div>

      <div className="w-full clip-corner-lg bg-destructive/10 p-3.5 text-left">
        <div className="flex items-start gap-2.5">
          <AlertTriangle className="mt-px size-4 shrink-0 text-destructive" />
          <div className="space-y-1">
            <p className="text-xs font-bold uppercase tracking-widest text-destructive">
              This key is your only login
            </p>
            <p className="text-xs leading-relaxed text-destructive/90">
              It can't be reset. Lose it and the account is gone. Anyone you share it
              with can act as you.
            </p>
          </div>
        </div>
      </div>

      {/* Reveal, then copy. No hide: that would only remove the copy button. */}
      <div className="relative w-full">
        <Input
          type={showKey ? "text" : "password"}
          value={nsec}
          readOnly
          className="pr-10 font-mono bg-background border-transparent"
        />
        {showKey ? (
          <Button
            type="button"
            variant="ghost"
            size="icon"
            className="absolute right-0 top-0 h-full px-3 hover:bg-transparent"
            onClick={copyKey}
            aria-label={copied ? "Key copied" : "Copy key"}
            title={copied ? "Copied" : "Copy key"}
          >
            {copied ? (
              <Check className="size-4 text-success" />
            ) : (
              <Copy className="size-4 text-muted-foreground" />
            )}
          </Button>
        ) : (
          <Button
            type="button"
            variant="ghost"
            size="icon"
            className="absolute right-0 top-0 h-full px-3 hover:bg-transparent"
            onClick={() => setShowKey(true)}
            aria-label="Show key"
            title="Show key"
          >
            <Eye className="size-4 text-muted-foreground" />
          </Button>
        )}
      </div>

      <div className="w-full space-y-2">
        <Button
          type="button"
          size="lg"
          variant={backedUp ? "secondary" : "default"}
          className="h-12 w-full clip-corner-lg text-base font-medium"
          onClick={saveKey}
          disabled={saving}
        >
          <Download className="size-4" />
          {saving ? "Saving…" : "Save key"}
        </Button>
        <div className="h-12">
          {backedUp && (
            <Button
              type="button"
              size="lg"
              className="h-12 w-full clip-corner-lg text-base font-medium animate-in fade-in slide-in-from-bottom-2 duration-300"
              onClick={onContinue}
            >
              {loggingIn ? "Continuing…" : "Continue"}
            </Button>
          )}
        </div>
        <p className="text-xs leading-relaxed text-muted-foreground">
          By creating an account, you agree to the{" "}
          <a href="/terms" className="text-primary hover:underline">
            Terms of Service
          </a>
          .
        </p>
      </div>
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

function hostOf(url: string): string {
  return url.replace(/^[a-z]+:\/\//i, "").replace(/\/+$/, "");
}

/**
 * Step 3 body: every relay and media server list the new account starts with,
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
            const first = list[0];
            const expanded = open === field;
            return (
              <Collapsible key={field} open={expanded} onOpenChange={(next) => setOpen(next ? field : null)}>
                <CollapsibleTrigger asChild>
                  <button type="button" className="flex w-full items-center gap-3 px-3 py-3 text-left touch:min-h-12">
                    <span className="text-sm font-medium text-foreground">{label}</span>
                    <span className="ml-auto flex min-w-0 items-center gap-1.5 font-mono text-xs text-muted-foreground">
                      {first && (field === "blossom" ? <BlossomLed url={first} /> : <RelayLed url={first} />)}
                      <span className="truncate">
                        {first ? hostOf(first) : "None"}
                        {list.length > 1 && ` +${list.length - 1}`}
                      </span>
                    </span>
                    <ChevronDown
                      className={cn(
                        "size-4 shrink-0 text-muted-foreground transition-transform duration-200",
                        expanded && "rotate-180",
                      )}
                    />
                  </button>
                </CollapsibleTrigger>
                <CollapsibleContent className="overflow-hidden data-[state=open]:animate-collapsible-down data-[state=closed]:animate-collapsible-up">
                  <div className="space-y-2 px-3 pb-3">
                    <p className="text-xs leading-snug text-muted-foreground">{hint}</p>
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
                  </div>
                </CollapsibleContent>
              </Collapsible>
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

/* Step 2 is {@link ProfileStepBody} in `./ProfileStep`. */
