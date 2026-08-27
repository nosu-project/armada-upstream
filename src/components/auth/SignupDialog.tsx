import React, { useEffect, useState } from 'react';

import { WizardShell } from '@/components/onboarding/WizardShell';
import {
  GenerateStepBody,
  ProfileStepBody,
  SaveKeyStepBody,
  useSignupKey,
} from '@/components/onboarding/signupSteps';
import { useCurrentUser } from '@/hooks/useCurrentUser';
import { useLoginActions } from '@/hooks/useLoginActions';
import { suppressNextSyncGate } from '@/hooks/useFreshLogin';
import { setOnboardingActive } from '@/hooks/useOnboarding';
import { toast } from '@/hooks/useToast';
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
 * The three steps — generate the key, save it (Continue gated on a real
 * backup), then a profile step — are the shared bodies in `signupSteps.tsx`,
 * the same ones the landing wizard ({@link SignupWizard}) renders; this file is
 * just the in-app chrome around them (an `isOpen`-driven full-screen shell that
 * resets on open, above Radix dialogs at `z-[255]`) plus the login. A brand-new
 * key carries the wizard's two fresh-account suppressions and raises the
 * onboarding flag, so the post-login setup flow ({@link LoginSetup}) — including
 * its "restore your setup" relay step, which is external-login recovery UI —
 * never fires over this signup.
 *
 * Unlike the landing wizard it seeds no relay list and does not navigate on
 * finish: once the profile step is done it hands back through `onComplete` and
 * dismisses, leaving the caller to resume whatever it opened signup for.
 */
const SignupDialog: React.FC<SignupDialogProps> = ({ isOpen, onClose, onComplete }) => {
  const login = useLoginActions();
  const { user } = useCurrentUser();
  const signupKey = useSignupKey();
  const [step, setStep] = useState<'generate' | 'download' | 'profile'>('generate');
  // True while the login is being persisted. Continue is asynchronous now, so
  // without this a second tap starts a second login for the same key.
  const [loggingIn, setLoggingIn] = useState(false);

  // Reset to a clean generate step each time the flow opens.
  useEffect(() => {
    if (!isOpen) return;
    setStep('generate');
    setLoggingIn(false);
    signupKey.reset();
    // signupKey is a fresh object each render; reset is stable in behavior.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isOpen]);

  // Whatever way this flow ends (finish, skip, or close), clear the onboarding
  // flag. It is raised synchronously at login (see handleContinue) to beat the
  // race that would let LoginSetup paint over the profile step; this is the
  // backstop for an unmount that skips finishOnboarding.
  useEffect(() => () => setOnboardingActive(false), []);

  const handleGenerate = () => {
    signupKey.generate();
    setStep('download');
  };

  // Leave the save step: log in as the new account and move to profile setup.
  // Only reachable once the key is backed up.
  //
  // Awaited: `login.nsec` persists the login (and, with an account already
  // active, performs the whole switch) asynchronously. Advancing before it
  // resolves moves to a step that renders on `user` — so the flow blanks until
  // the login commits — and leaves a rejected persist with no handler at all,
  // for a key whose only copy the user was just told to back up.
  const handleContinue = async () => {
    if (loggingIn) return;
    const { identity, nsec } = signupKey;
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
        <GenerateStepBody onGenerate={handleGenerate} />
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
        <SaveKeyStepBody signupKey={signupKey} loggingIn={loggingIn} onContinue={handleContinue} />
      </WizardShell>
    );
  }

  // ── Step 3: profile setup ───────────────────────────────────────────────
  // No back arrow: the previous step created the account, and there is no
  // un-creating it. Rendered only once `user` exists (the login above committed
  // it); until then this returns nothing, which is why the save step stays put
  // through the in-flight login.
  if (step === 'profile' && user) {
    return (
      <WizardShell index={2} total={3} stepKey="profile" maxWidth="max-w-xl" zClassName="z-[255]" onClose={finishOnboarding}>
        <ProfileStepBody onFinish={finishOnboarding} />
      </WizardShell>
    );
  }

  // The login has been requested but `user` hasn't committed yet (or an
  // unexpected state): the save step above stays rendered until it does, so
  // there is nothing to draw here.
  return null;
};

export default SignupDialog;
