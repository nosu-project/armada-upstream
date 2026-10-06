import React, { useEffect, useState } from 'react';

import { ProfileStepBody } from '@/components/onboarding/ProfileStep';
import { WizardShell } from '@/components/onboarding/WizardShell';
import {
  GenerateStepBody,
  SaveKeyStepBody,
  useSignupKey,
} from '@/components/onboarding/signupSteps';
import { useCurrentUser } from '@/hooks/useCurrentUser';
import { useLoginActions } from '@/hooks/useLoginActions';
import { suppressNextSyncGate } from '@/hooks/useFreshLogin';
import { setOnboardingActive } from '@/hooks/useOnboarding';
import { toast } from '@/hooks/useToast';
import { markNotificationSettingsReady } from '@/lib/notificationSettingsAuthority';
import { markRelayRecoveryPromptShown } from '@/lib/relayRecoveryPrompt';

interface SignupDialogProps {
  isOpen: boolean;
  onClose: () => void;
  /** Called after account creation and the profile step, so the caller can resume. */
  onComplete?: () => void;
}

/**
 * In-app account creation (from {@link LoginScreen}'s "Create account"). Shares
 * step bodies with the landing {@link SignupWizard} (`signupSteps.tsx`,
 * `ProfileStep.tsx`) but seeds no relay list and doesn't navigate; it hands
 * back through `onComplete`. A fresh key suppresses the sync gate and
 * {@link LoginSetup}'s restore step.
 */
const SignupDialog: React.FC<SignupDialogProps> = ({ isOpen, onClose, onComplete }) => {
  const login = useLoginActions();
  const { user } = useCurrentUser();
  const signupKey = useSignupKey();
  const [step, setStep] = useState<'generate' | 'download' | 'profile'>('generate');
  // Prevents a second tap from starting a second login for the same key.
  const [loggingIn, setLoggingIn] = useState(false);

  useEffect(() => {
    if (!isOpen) return;
    setStep('generate');
    setLoggingIn(false);
    signupKey.reset();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isOpen]);

  // Backstop for an unmount that skips finishOnboarding.
  useEffect(() => () => setOnboardingActive(false), []);

  const handleGenerate = () => {
    signupKey.generate();
    setStep('download');
  };

  // Only reachable once the key is backed up. Awaited: the profile step renders
  // on `user`, and a rejected persist must be handled.
  const handleContinue = async () => {
    if (loggingIn) return;
    const { identity, nsec } = signupKey;
    // Brand-new key: skip the post-login sync gate and LoginSetup's restore step
    // (see SignupWizard.handleContinue).
    if (identity) {
      suppressNextSyncGate(identity.pubkey);
      markRelayRecoveryPromptShown(identity.pubkey);
      markNotificationSettingsReady(identity.pubkey);
    }
    // BEFORE login, so LoginSetup (z-[260]) never paints over the profile step (z-[255]).
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

  const finishOnboarding = () => {
    setOnboardingActive(false);
    onComplete?.();
    onClose();
  };

  if (!isOpen) return null;

  if (step === 'generate') {
    return (
      <WizardShell index={0} total={3} stepKey="generate" zClassName="z-[255]" onClose={onClose}>
        <GenerateStepBody onGenerate={handleGenerate} />
      </WizardShell>
    );
  }

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

  // No back arrow: the account can't be un-created. Waits for `user` to commit.
  if (step === 'profile' && user) {
    return (
      <WizardShell index={2} total={3} stepKey="profile" zClassName="z-[255]" onClose={finishOnboarding}>
        <ProfileStepBody
          expectedPubkey={signupKey.identity?.pubkey}
          onFinish={finishOnboarding}
        />
      </WizardShell>
    );
  }

  // Login requested but `user` not yet committed; the save step stays rendered.
  return null;
};

export default SignupDialog;
