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
 * The shared parts of account creation, so the landing wizard
 * ({@link SignupWizard}) and the in-app dialog ({@link SignupDialog}) don't
 * carry two copies of the key-backup path between them.
 *
 * What lives here is everything the two flows do IDENTICALLY: minting the key,
 * the backup gate (the {@link useSignupKey} hook), and the two key step BODIES
 * (generate, save; the profile step is {@link ProfileStepBody}, in its own
 * module for the reason noted below). What stays with each consumer is everything they
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
   * keyring save, or file export. This is what makes Continue appear on the
   * save step; until then the step has nothing to continue from.
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
  // advance: Continue appears only once this (or Copy) has actually
  // succeeded, so the outcomes stay apart rather than collapsing into "the
  // button ran". A dismissed dialog leaves the step where it was.
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
            "Save the file — or reveal the key and copy it — before continuing. It's your only login.",
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

/**
 * Step 1 body: mint the key. Wrap in the consumer's wizard shell.
 *
 * The Terms of Service notice is a plain anchor, not a router Link: both
 * signup surfaces render outside any spot a mid-wizard route change would be
 * safe, and /terms is a real page on every platform.
 */
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
 * Step 2 body: back the key up, then continue.
 *
 * The step asks for ONE thing at a time. It opens with a single action — Save
 * key — because a file the user watched go somewhere is the backup worth
 * having, and a second button of equal weight beside it ("Copy key") only
 * turned that into a choice between two things neither of which had been
 * explained. Copying is still there, but as what it is: an affordance ON the
 * key, reached by looking at it. Revealing the key swaps the eye for a
 * clipboard, since a key that has been on screen has nothing left to hide.
 *
 * Continue is not disabled-until-backed-up, it is ABSENT until backed up —
 * a disabled button is a thing to try clicking and be told nothing by. It
 * occupies its space the whole time, so nothing moves when it arrives, and it
 * fades in rather than appearing, so the arrival is legible as a consequence
 * of the tap that caused it.
 *
 * The key state comes from {@link useSignupKey}; `loggingIn` and `onContinue`
 * belong to the consumer, which logs in (and advances) differently.
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

      {/* One slot at the input's edge, holding whichever affordance the key's
          state has earned: reveal it, or — once it is already on screen —
          copy it. There is no hide: the key has been seen, and a toggle back
          would only take away the copy button the reveal just produced. */}
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

      {/* The step's one action, then the space Continue will occupy. The slot
          is sized and reserved from the first frame so the arrival of Continue
          moves nothing; `backedUp` is what fills it — a copy or a save that
          actually succeeded. */}
      <div className="w-full space-y-2">
        <Button
          type="button"
          size="lg"
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
              variant="secondary"
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

/* Step 3's body — the profile screen — is {@link ProfileStepBody} in
   `./ProfileStep`. It lives apart because it is the only step that reaches
   the publish path, the Blossom uploaders and the query cache. */
