import { useMemo, useState, type Dispatch, type SetStateAction } from "react";
import { AlertTriangle, Check, Copy, Download, Eye, EyeOff } from "lucide-react";
import { generateSecretKey, getPublicKey, nip19 } from "nostr-tools";

import { ArmadaIdentity, ArmadaKey } from "@/components/brand/ArmadaCrest";
import { ProfileSettings } from "@/components/ProfileSettings";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { toast } from "@/hooks/useToast";
import { writeClipboardText } from "@/lib/clipboard";
import { backUpNsec } from "@/lib/credentialManager";

/**
 * The shared parts of account creation, so the landing wizard
 * ({@link SignupWizard}) and the in-app dialog ({@link SignupDialog}) don't
 * carry two copies of the key-backup path between them.
 *
 * What lives here is everything the two flows do IDENTICALLY: minting the key,
 * the backup gate (the {@link useSignupKey} hook), and the three step BODIES
 * (generate, save, profile). What stays with each consumer is everything they
 * do differently — the login itself, the fresh-account suppressions, the
 * onboarding flag, relay-list seeding, the mount model, the wizard chrome
 * (progress bar vs bare shell, z-index), and the exit (navigate to /discover
 * vs an `onComplete` callback). So the bodies are wrapped in each consumer's
 * own shell, and the step transitions stay with each consumer's step machine.
 */

export interface SignupKey {
  /** The current nsec, or "" before generation. */
  nsec: string;
  /** The generated key's identity, or null while there's no valid key in hand. */
  identity: { pubkey: string; npub: string } | null;
  showKey: boolean;
  setShowKey: Dispatch<SetStateAction<boolean>>;
  copied: boolean;
  /** True while the OS keyring / "Save as…" sheet is up. */
  saving: boolean;
  /**
   * True once the key has demonstrably left the screen — a successful Copy,
   * keyring save, or file export. The Continue gate on the save step.
   */
  backedUp: boolean;
  /** Mint a fresh key and reset the backup gate. */
  generate: () => void;
  /** Copy the key to the clipboard (satisfies the backup gate on success). */
  copyKey: () => Promise<void>;
  /** Back the key up via the OS/file dialog (satisfies the gate on success). */
  saveKey: () => Promise<void>;
  /** Return to a pristine, key-less state (the dialog reuses one instance). */
  reset: () => void;
}

/**
 * The key-generation and backup half of signup. Owns the key, its derived
 * identity, and the backup gate; the step transitions and the login itself
 * stay with each consumer, which differ.
 */
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

  // Back the key up to a place the user chose and watched it go to — a "Save
  // as…" dialog on web, the Credential Manager sheet on native. Doesn't
  // advance: Continue is gated on this (or Copy) having actually succeeded, so
  // the outcomes stay apart rather than collapsing into "the button ran". A
  // dismissed dialog leaves the gate shut.
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
          description: "Save the file — or Copy the key — before continuing. It's your only login.",
        });
        return;
      }
      if (result.status === "failed") {
        toast({
          title: "Couldn't save your key",
          description: "Saving failed. Copy your key and store it somewhere safe, then continue.",
          variant: "destructive",
        });
        return;
      }
      setBackedUp(true);
      toast({
        title: "Key saved",
        description: `Saved to ${result.location}. Keep it — it's your only login.`,
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

/** Step 1 body: mint the key. Wrap in the consumer's wizard shell. */
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
          No email, no phone number, no password to forget.
        </p>
      </div>
      <Button
        size="lg"
        className="h-12 w-full clip-corner-lg text-base font-medium"
        onClick={onGenerate}
      >
        Generate my key
      </Button>
    </div>
  );
}

/**
 * Step 2 body: reveal the key and gate Continue on an actual backup. The key
 * state comes from {@link useSignupKey}; `loggingIn` and `onContinue` belong to
 * the consumer, which logs in (and advances) differently.
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

      {/* The one thing this step has to land. There is no second copy of
          this key and no way to reissue it, so the warning IS the step's
          description rather than a footnote under a milder one. */}
      <div className="w-full clip-corner-lg bg-destructive/10 p-3.5 text-left">
        <div className="flex items-start gap-2.5">
          <AlertTriangle className="mt-px size-4 shrink-0 text-destructive" />
          <div className="space-y-1">
            <p className="text-xs font-bold uppercase tracking-widest text-destructive">
              This key is your only login
            </p>
            <p className="text-xs leading-relaxed text-destructive/90">
              No reset, no recovery. Lose it and the account is gone; share it and
              whoever has it is you.
            </p>
          </div>
        </div>
      </div>

      <div className="relative w-full">
        <Input
          type={showKey ? "text" : "password"}
          value={nsec}
          readOnly
          className="pr-10 font-mono bg-background border-transparent"
        />
        <Button
          type="button"
          variant="ghost"
          size="icon"
          className="absolute right-0 top-0 h-full px-3 hover:bg-transparent"
          onClick={() => setShowKey((v) => !v)}
        >
          {showKey ? (
            <EyeOff className="size-4 text-muted-foreground" />
          ) : (
            <Eye className="size-4 text-muted-foreground" />
          )}
        </Button>
      </div>

      {/* Two ways to back the key up, then the gate. Continue stays shut
          until one of them has actually succeeded — see `backedUp`. */}
      <div className="w-full space-y-2">
        <div className="grid grid-cols-2 gap-2">
          <Button
            type="button"
            variant="secondary"
            className="h-11 clip-corner-lg"
            onClick={saveKey}
            disabled={saving}
          >
            <Download className="size-4" />
            {saving ? "Saving…" : "Save key"}
          </Button>
          <Button
            type="button"
            variant="secondary"
            className="h-11 clip-corner-lg"
            onClick={copyKey}
            disabled={saving}
          >
            {copied ? (
              <Check className="size-4 text-success" />
            ) : (
              <Copy className="size-4" />
            )}
            {copied ? "Copied" : "Copy key"}
          </Button>
        </div>
        <Button
          size="lg"
          className="h-12 w-full clip-corner-lg text-base font-medium"
          onClick={onContinue}
          disabled={!backedUp || saving || loggingIn}
        >
          Continue
        </Button>
      </div>
    </div>
  );
}

/**
 * Step 3 body: the shared {@link ProfileSettings} editor plus a skip. `onFinish`
 * runs on both save and skip — every step past key-save is skippable.
 */
export function ProfileStepBody({ onFinish }: { onFinish: () => void }) {
  return (
    <>
      <div className="space-y-1.5 text-center">
        <ArmadaIdentity size={84} className="mx-auto mb-4" />
        <h1 className="font-mono text-2xl font-bold lowercase tracking-tight text-foreground">
          set up your profile
        </h1>
        <p className="text-sm text-muted-foreground">
          How people see you. You can change it anytime.
        </p>
      </div>

      {/* Continue lives inside the editor, so Skip is spaced against it
          directly rather than left to the column's wider step gap. (Not a
          `space-y-*` wrapper: ProfileSettings' hidden file inputs are
          siblings of its form, so the rule would land on the form too.) */}
      <div>
        <ProfileSettings saveLabel="Continue" centerSave showNip05={false} onSaved={onFinish} />
        <Button
          variant="ghost"
          className="mx-auto mt-2 flex text-muted-foreground"
          onClick={onFinish}
        >
          Skip for now
        </Button>
      </div>
    </>
  );
}
