import React, { useEffect, useMemo, useState } from 'react';
import { AlertTriangle, Check, Copy, Download, Eye, EyeOff } from 'lucide-react';
import { generateSecretKey, getPublicKey, nip19 } from 'nostr-tools';

import { ArmadaIdentity, ArmadaKey } from '@/components/brand/ArmadaCrest';
import { WizardShell } from '@/components/onboarding/WizardShell';
import { ProfileSettings } from '@/components/ProfileSettings';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { useCurrentUser } from '@/hooks/useCurrentUser';
import { useLoginActions } from '@/hooks/useLoginActions';
import { suppressNextSyncGate } from '@/hooks/useFreshLogin';
import { setOnboardingActive } from '@/hooks/useOnboarding';
import { toast } from '@/hooks/useToast';
import { writeClipboardText } from '@/lib/clipboard';
import { backUpNsec } from '@/lib/credentialManager';
import { markRelayRecoveryPromptShown } from '@/lib/relayRecoveryPrompt';

interface SignupDialogProps {
  isOpen: boolean;
  onClose: () => void;
  /**
   * Called once the account is created, logged in, and the user has finished
   * (or skipped) the profile step. Optional: the in-app call sites
   * ({@link JoinButton}, {@link LoginArea}, {@link GroupChat}) use it to resume
   * whatever they opened signup for (e.g. joining the invited community).
   */
  onComplete?: () => void;
}

/**
 * Account creation reached from anywhere in the app that isn't the landing
 * page — the "Create account" escape hatch inside {@link LoginScreen}, opened
 * by {@link JoinButton}, {@link LoginArea} and {@link GroupChat}.
 *
 * This is the same full-screen {@link WizardShell} flow the landing wizard
 * ({@link WelcomePage}) uses, not a modal, and now the same THREE steps:
 * generate a key; a save step whose Continue is gated on the key having
 * demonstrably left the screen (a successful Copy, keyring save, or file
 * export) so a new user can't skip past backing up their only login; and a
 * profile step (the shared {@link ProfileSettings} editor) so a user who
 * signed up through an invite link is asked for a name/avatar just like one
 * who came in off the landing page. A brand-new key carries the wizard's two
 * fresh-account suppressions and raises the onboarding flag, so the post-login
 * setup flow ({@link LoginSetup}) — including its "restore your setup" relay
 * step, which is external-login recovery UI — never fires over this signup.
 */
const SignupDialog: React.FC<SignupDialogProps> = ({ isOpen, onClose, onComplete }) => {
  const login = useLoginActions();
  const { user } = useCurrentUser();
  const [step, setStep] = useState<'generate' | 'download' | 'profile'>('generate');
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

  // Whatever way this flow ends (finish, skip, or close), clear the onboarding
  // flag. It is raised synchronously at login (see handleContinue) to beat the
  // race that would let LoginSetup paint over the profile step; this is the
  // backstop for an unmount that skips finishOnboarding.
  useEffect(() => () => setOnboardingActive(false), []);

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

  // Leave the save step: log in as the new account and move to profile setup.
  // Only reachable once `backedUp`.
  //
  // Awaited: `login.nsec` persists the login (and, with an account already
  // active, performs the whole switch) asynchronously. Advancing before it
  // resolves moves to a step that renders on `user` — so the flow blanks until
  // the login commits — and leaves a rejected persist with no handler at all,
  // for a key whose only copy the user was just told to back up.
  const handleContinue = async () => {
    if (loggingIn) return;
    // This is a brand-new key, so it shares the account wizard's two
    // fresh-account suppressions (see SignupWizard.handleContinue): it has
    // nothing on any relay to catch up on, so skip the post-login sync gate,
    // and nothing to recover, so never show the "restore your setup" relay
    // step in LoginSetup — that is external-login recovery UI and has no place
    // in a fresh signup.
    if (identity) {
      suppressNextSyncGate(identity.pubkey);
      markRelayRecoveryPromptShown(identity.pubkey);
    }
    // Raise the onboarding flag BEFORE login so it's already true on the commit
    // that first exposes the user — otherwise the post-login setup flow
    // (LoginSetup, z-[260]) would enqueue and paint over the profile step
    // (z-[255]). Cleared by finishOnboarding, or on unmount.
    setOnboardingActive(true);
    setLoggingIn(true);
    try {
      await login.nsec(nsec);
    } catch {
      setLoggingIn(false);
      setOnboardingActive(false);
      toast({
        title: 'Couldn\'t sign in',
        description: 'Your key was created but could not be saved to this device. Keep your backup and try again.',
        variant: 'destructive',
      });
      return;
    }
    setStep('profile');
  };

  // End of the profile step (saved or skipped): clear the onboarding flag,
  // hand back to the caller, and dismiss.
  const finishOnboarding = () => {
    setOnboardingActive(false);
    onComplete?.();
    onClose();
  };

  if (!isOpen) return null;

  // ── Step 1: generate the key ────────────────────────────────────────────
  if (step === 'generate') {
    return (
      <WizardShell index={0} total={3} stepKey="generate" zClassName="z-[255]" onClose={onClose}>
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
  if (step === 'download') {
    return (
    <WizardShell
      index={1}
      total={3}
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
  }

  // ── Step 3: profile setup ───────────────────────────────────────────────
  // No back arrow: the previous step created the account, and there is no
  // un-creating it. A back arrow here could only return to a key screen whose
  // own back leads forward again — a loop, not a step back. Rendered only once
  // `user` exists (the login above committed it); until then this returns
  // nothing, which is why the save step stays put through the in-flight login.
  if (step === 'profile' && user) {
    return (
      <WizardShell index={2} total={3} stepKey="profile" maxWidth="max-w-xl" zClassName="z-[255]" onClose={finishOnboarding}>
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
          <ProfileSettings saveLabel="Continue" centerSave showNip05={false} onSaved={finishOnboarding} />
          <Button
            variant="ghost"
            className="mx-auto mt-2 flex text-muted-foreground"
            onClick={finishOnboarding}
          >
            Skip for now
          </Button>
        </div>
      </WizardShell>
    );
  }

  // The login has been requested but `user` hasn't committed yet (or an
  // unexpected state): the save step above stays rendered until it does, so
  // there is nothing to draw here.
  return null;
};

export default SignupDialog;
