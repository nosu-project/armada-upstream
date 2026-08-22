import React, { useEffect, useMemo, useState } from 'react';
import { AlertTriangle, Check, Copy, Download, Eye, EyeOff } from 'lucide-react';
import { generateSecretKey, getPublicKey, nip19 } from 'nostr-tools';

import { ArmadaIdentity, ArmadaKey } from '@/components/brand/ArmadaCrest';
import { WizardShell } from '@/components/onboarding/WizardShell';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { useLoginActions } from '@/hooks/useLoginActions';
import { toast } from '@/hooks/useToast';
import { writeClipboardText } from '@/lib/clipboard';
import { backUpNsec } from '@/lib/credentialManager';

interface SignupDialogProps {
  isOpen: boolean;
  onClose: () => void;
  /**
   * Called after the account is created and the user is logged in. Optional:
   * the landing wizard drives its own profile step from {@link WelcomePage};
   * the in-app call sites ({@link JoinButton}, {@link LoginArea},
   * {@link GroupChat}) just want the account made and the flow dismissed.
   */
  onComplete?: () => void;
}

/**
 * Account creation reached from anywhere in the app that isn't the landing
 * page — the "Create account" escape hatch inside {@link LoginScreen}, opened
 * by {@link JoinButton}, {@link LoginArea} and {@link GroupChat}.
 *
 * This is the same full-screen {@link WizardShell} flow the landing wizard
 * ({@link WelcomePage}) uses, not a modal: generate a key, then a save step
 * whose Continue is gated on the key having demonstrably left the screen — a
 * successful Copy, keyring save, or file export — so a new user can't skip
 * past backing up their only login. It stays a self-contained two-step flow
 * (no profile step); once logged in the app decides where they land.
 */
const SignupDialog: React.FC<SignupDialogProps> = ({ isOpen, onClose, onComplete }) => {
  const login = useLoginActions();
  const [step, setStep] = useState<'generate' | 'download'>('generate');
  const [nsec, setNsec] = useState('');
  const [showKey, setShowKey] = useState(false);
  const [copied, setCopied] = useState(false);
  // True while the save-key dialog / keyring sheet is up.
  const [saving, setSaving] = useState(false);
  // The gate on the save step: Continue stays disabled until the key has
  // demonstrably left this screen — copied, stored in the OS keyring, or
  // written to a file. A dismissed keyring sheet is not a backup.
  const [backedUp, setBackedUp] = useState(false);
  // True while the login is being persisted. Continue is asynchronous now, so
  // without this a second tap starts a second login for the same key.
  const [loggingIn, setLoggingIn] = useState(false);

  // Reset to a clean generate step each time the flow opens.
  useEffect(() => {
    if (!isOpen) return;
    setStep('generate');
    setNsec('');
    setShowKey(false);
    setCopied(false);
    setSaving(false);
    setBackedUp(false);
    setLoggingIn(false);
  }, [isOpen]);

  /** The generated key's identity, or null while there's no valid key in hand. */
  const identity = useMemo(() => {
    if (!nsec) return null;
    try {
      const decoded = nip19.decode(nsec);
      if (decoded.type !== 'nsec') return null;
      const pubkey = getPublicKey(decoded.data);
      return { pubkey, npub: nip19.npubEncode(pubkey) };
    } catch {
      return null;
    }
  }, [nsec]);

  const handleGenerate = () => {
    setNsec(nip19.nsecEncode(generateSecretKey()));
    setShowKey(false);
    setCopied(false);
    setBackedUp(false);
    setStep('download');
  };

  const copyKey = async () => {
    try {
      await writeClipboardText(nsec);
      setCopied(true);
      setBackedUp(true);
      setTimeout(() => setCopied(false), 2000);
    } catch {
      toast({
        title: 'Copy failed',
        description: 'Could not copy to the clipboard. Please select and copy it manually.',
        variant: 'destructive',
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
        title: 'Invalid key',
        description: 'That key is invalid. Please generate a new one.',
        variant: 'destructive',
      });
      return;
    }

    setSaving(true);
    try {
      const result = await backUpNsec(identity.npub, nsec);
      if (result.status === 'cancelled') {
        toast({
          title: 'Key not saved',
          description: 'Save the file — or Copy the key — before continuing. It\'s your only login.',
        });
        return;
      }
      if (result.status === 'failed') {
        toast({
          title: 'Couldn\'t save your key',
          description: 'Saving failed. Copy your key and store it somewhere safe, then continue.',
          variant: 'destructive',
        });
        return;
      }
      setBackedUp(true);
      toast({
        title: 'Key saved',
        description: `Saved to ${result.location}. Keep it — it's your only login.`,
      });
    } finally {
      setSaving(false);
    }
  };

  // Log in as the new account and dismiss. Only reachable once `backedUp`.
  //
  // Awaited: `login.nsec` persists the login (and, with an account already
  // active, performs the whole switch) asynchronously. Dismissing before it
  // resolves would report an account that isn't durable yet, and a rejected
  // persist would have no handler at all — for a key whose only copy the user
  // was just told to back up.
  const handleContinue = async () => {
    if (loggingIn) return;
    setLoggingIn(true);
    try {
      await login.nsec(nsec);
    } catch {
      setLoggingIn(false);
      toast({
        title: 'Couldn\'t sign in',
        description: 'Your key was created but could not be saved to this device. Keep your backup and try again.',
        variant: 'destructive',
      });
      return;
    }
    onComplete?.();
    onClose();
  };

  if (!isOpen) return null;

  // ── Step 1: generate the key ────────────────────────────────────────────
  if (step === 'generate') {
    return (
      <WizardShell index={0} total={2} stepKey="generate" zClassName="z-[255]" onClose={onClose}>
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
            onClick={handleGenerate}
          >
            Generate my key
          </Button>
        </div>
      </WizardShell>
    );
  }

  // ── Step 2: save the key ────────────────────────────────────────────────
  return (
    <WizardShell
      index={1}
      total={2}
      stepKey="download"
      zClassName="z-[255]"
      onBack={() => setStep('generate')}
      onClose={onClose}
    >
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
            type={showKey ? 'text' : 'password'}
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
              {saving ? 'Saving…' : 'Save key'}
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
              {copied ? 'Copied' : 'Copy key'}
            </Button>
          </div>
          <Button
            size="lg"
            className="h-12 w-full clip-corner-lg text-base font-medium"
            onClick={handleContinue}
            disabled={!backedUp || saving || loggingIn}
          >
            Continue
          </Button>
        </div>
      </div>
    </WizardShell>
  );
};

export default SignupDialog;
