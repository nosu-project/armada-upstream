import { useMemo, useState, type Dispatch, type SetStateAction } from "react";
import { AlertTriangle, Check, Copy, Download, Eye } from "lucide-react";
import { generateSecretKey, getPublicKey, nip19 } from "nostr-tools";

import { ArmadaIdentity, ArmadaKey } from "@/components/brand/ArmadaCrest";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { toast } from "@/hooks/useToast";
import { writeClipboardText } from "@/lib/clipboard";
import { backUpNsec } from "@/lib/credentialManager";

/**
 * Shared account-creation parts for {@link SignupWizard} and {@link SignupDialog}:
 * key minting, the backup gate ({@link useSignupKey}) and the key step bodies.
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
  generate: () => void;
  copyKey: () => Promise<void>;
  saveKey: () => Promise<void>;
  /** Return to a pristine, key-less state (the dialog reuses one instance). */
  reset: () => void;
}

export function useSignupKey(): SignupKey {
  const [nsec, setNsec] = useState("");
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

  const generate = () => {
    setNsec(nip19.nsecEncode(generateSecretKey()));
    setShowKey(false);
    setCopied(false);
    setBackedUp(false);
  };

  const reset = () => {
    setNsec("");
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
    generate,
    copyKey,
    saveKey,
    reset,
  };
}

/** Step 1 body. ToS is a plain anchor: a mid-wizard route change isn't safe, and /terms exists everywhere. */
export function GenerateStepBody({ onGenerate }: { onGenerate: () => void }) {
  return (
    <div className="flex flex-col items-center gap-8 text-center">
      <ArmadaIdentity size={110} />
      <div className="space-y-2.5">
        <h1 className="font-mono text-2xl font-bold lowercase tracking-tight text-foreground">
          create your account
        </h1>
        <p className="text-sm leading-relaxed text-muted-foreground">
          Your identity is a secret key that lives on your device.
          There's no email or password.
        </p>
      </div>
      <div className="w-full space-y-3">
        <Button
          size="lg"
          className="h-12 w-full clip-corner-lg text-base font-medium"
          onClick={onGenerate}
        >
          Generate my key
        </Button>
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

/**
 * Step 2 body: back the key up. Continue is ABSENT (not disabled) until backed
 * up, with its space reserved so nothing moves when it fades in.
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
      <ArmadaKey size={110} />
      <h1 className="font-mono text-2xl font-bold lowercase tracking-tight text-foreground">
        save your secret key
      </h1>

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
      </div>
    </div>
  );
}

/* Step 3 is {@link ProfileStepBody} in `./ProfileStep`. */
