// NOTE: This file is stable and usually should not be modified.
// It is important that all functionality in this file is preserved, and should only be modified if explicitly requested.

import React, { useState, useEffect } from 'react';
import { Eye, EyeOff, KeyRound } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Dialog, ChromeDialogContent } from "@/components/ui/dialog";
import { toast } from '@/hooks/useToast';
import { useLoginActions } from '@/hooks/useLoginActions';
import { generateSecretKey, getPublicKey, nip19 } from 'nostr-tools';
import { saveNsec } from '@/lib/credentialManager';

interface SignupDialogProps {
  isOpen: boolean;
  onClose: () => void;
  /**
   * Called after the account is created and the key is saved (the user is
   * logged in at this point). The welcome-page onboarding uses this to start
   * the full-page profile-creation step; profile setup no longer lives in
   * this dialog.
   */
  onComplete?: () => void;
}

const SignupDialog: React.FC<SignupDialogProps> = ({ isOpen, onClose, onComplete }) => {
  const [step, setStep] = useState<'generate' | 'download'>('generate');
  const [nsec, setNsec] = useState('');
  const [showKey, setShowKey] = useState(false);
  const login = useLoginActions();

  // Generate a proper nsec key using nostr-tools.
  const generateKey = () => {
    const sk = generateSecretKey();
    const encoded = nip19.nsecEncode(sk);
    setNsec(encoded);
    setStep('download');
  };

  // Save the key via the best available method (credential manager on
  // Chromium, file download elsewhere), log in, and finish. Profile setup
  // happens afterwards in the full-page onboarding (see WelcomePage), not
  // here.
  const handleContinue = async () => {
    try {
      const decoded = nip19.decode(nsec);
      if (decoded.type !== 'nsec') {
        throw new Error('Invalid nsec key');
      }

      const pubkey = getPublicKey(decoded.data);
      const npub = nip19.npubEncode(pubkey);

      await saveNsec(npub, nsec);

      login.nsec(nsec);
      onComplete?.();
      onClose();
    } catch {
      toast({
        title: 'Save failed',
        description: 'Could not save the key. Please copy it manually.',
        variant: 'destructive',
      });
    }
  };

  const getTitle = () => {
    if (step === 'generate') return 'sign up';
    return 'secret key';
  };

  // Reset state when dialog opens
  useEffect(() => {
    if (isOpen) {
      setStep('generate');
      setNsec('');
      setShowKey(false);
    }
  }, [isOpen]);

  return (
    <Dialog open={isOpen} onOpenChange={onClose}>
      <ChromeDialogContent title={getTitle() ?? 'Sign up'}>
        <div className="flex flex-col items-center gap-2 text-center">
          <div className="flex size-12 items-center justify-center clip-corner-lg bg-primary/15 text-primary">
            <KeyRound className="size-6" />
          </div>
          <h2 className="chrome-dialog-title font-mono font-bold lowercase tracking-tight text-foreground">
            {getTitle()}
          </h2>
        </div>

        <div className='mt-6 space-y-4 overflow-y-auto'>
          {/* Generate Step */}
          {step === 'generate' && (
            <div className='text-center space-y-6'>
              <p className="text-sm text-muted-foreground">
                We&apos;ll generate a secret key, your one and only login. Keep it safe.
              </p>
              <Button className="w-full h-12 clip-corner-lg" onClick={generateKey}>
                Generate key
              </Button>
            </div>
          )}

          {/* Save Key Step */}
          {step === 'download' && (
            <div className='space-y-4'>
              <div className="relative">
                <Input
                  type={showKey ? "text" : "password"}
                  value={nsec}
                  readOnly
                  className="pr-10 font-mono bg-background/40 border-transparent"
                />
                <Button
                  type="button"
                  variant="ghost"
                  size="icon"
                  className="absolute right-0 top-0 h-full px-3 hover:bg-transparent"
                  onClick={() => setShowKey(!showKey)}
                >
                  {showKey ? (
                    <EyeOff className="h-4 w-4 text-muted-foreground" />
                  ) : (
                    <Eye className="h-4 w-4 text-muted-foreground" />
                  )}
                </Button>
              </div>

              <Button
                className="w-full h-12 clip-corner-lg"
                onClick={handleContinue}
              >
                Continue
              </Button>

              <div className='clip-corner-lg bg-amber-500/10 p-3'>
                <div className='flex items-center gap-2 mb-1'>
                  <span className='text-xs font-semibold text-amber-600 dark:text-amber-300'>
                    Important Warning
                  </span>
                </div>
                <p className='text-xs text-amber-700 dark:text-amber-300/90'>
                  This key is your primary and only means of accessing your account. Store it safely and securely.
                </p>
              </div>
            </div>
          )}
        </div>
      </ChromeDialogContent>
    </Dialog>
  );
};

export default SignupDialog;
