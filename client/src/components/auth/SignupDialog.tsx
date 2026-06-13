// NOTE: This file is stable and usually should not be modified.
// It is important that all functionality in this file is preserved, and should only be modified if explicitly requested.

import React, { useState, useEffect } from 'react';
import { Eye, EyeOff, Loader2 } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Textarea } from '@/components/ui/textarea';
import { Label } from '@/components/ui/label';
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { toast } from '@/hooks/useToast';
import { useLoginActions } from '@/hooks/useLoginActions';
import { useNostrPublish } from '@/hooks/useNostrPublish';
import { generateSecretKey, getPublicKey, nip19 } from 'nostr-tools';
import { saveNsec } from '@/lib/credentialManager';

interface SignupDialogProps {
  isOpen: boolean;
  onClose: () => void;
}

const SignupDialog: React.FC<SignupDialogProps> = ({ isOpen, onClose }) => {
  const [step, setStep] = useState<'generate' | 'download' | 'profile'>('generate');
  const [nsec, setNsec] = useState('');
  const [showKey, setShowKey] = useState(false);
  const [name, setName] = useState('');
  const [about, setAbout] = useState('');
  const login = useLoginActions();
  const { mutateAsync: publishEvent, isPending: isPublishing } = useNostrPublish();

  // Generate a proper nsec key using nostr-tools.
  const generateKey = () => {
    const sk = generateSecretKey();
    const encoded = nip19.nsecEncode(sk);
    setNsec(encoded);
    setStep('download');
  };

  // Save the key via the best available method (credential manager on
  // Chromium, file download elsewhere), log in, and advance to profile setup.
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
      setStep('profile');
    } catch {
      toast({
        title: 'Save failed',
        description: 'Could not save the key. Please copy it manually.',
        variant: 'destructive',
      });
    }
  };

  const finishSignup = async (skipProfile = false) => {
    try {
      if (!skipProfile && (name || about)) {
        const data: Record<string, string> = {};
        if (name) data.name = name;
        if (about) data.about = about;
        await publishEvent({
          kind: 0,
          content: JSON.stringify(data),
          tags: [],
        });
      }
    } catch {
      toast({
        title: 'Profile Setup Failed',
        description: 'Your account was created but profile setup failed. You can update it later.',
        variant: 'destructive',
      });
    } finally {
      onClose();
    }
  };

  const getTitle = () => {
    if (step === 'generate') return 'Sign up';
    if (step === 'download') return 'Secret Key';
    if (step === 'profile') return 'Create Your Profile';
  };

  // Reset state when dialog opens
  useEffect(() => {
    if (isOpen) {
      setStep('generate');
      setNsec('');
      setShowKey(false);
      setName('');
      setAbout('');
    }
  }, [isOpen]);

  return (
    <Dialog open={isOpen} onOpenChange={onClose}>
      <DialogContent className="max-w-[95vw] sm:max-w-sm max-h-[90dvh] p-0 gap-6 overflow-hidden rounded-2xl overflow-y-auto">
        <DialogHeader className="px-6 pt-6">
          <DialogTitle className="text-lg font-semibold leading-none tracking-tight text-center">
            {getTitle()}
          </DialogTitle>
        </DialogHeader>

        <div className='px-6 pb-6 space-y-4 overflow-y-auto flex-1'>
          {/* Generate Step */}
          {step === 'generate' && (
            <div className='text-center space-y-6'>
              <div className="flex size-40 text-8xl bg-primary/10 rounded-full items-center justify-center justify-self-center">
                🔑
              </div>

              <Button className="w-full h-12 px-9" onClick={generateKey}>
                Generate key
              </Button>
            </div>
          )}

          {/* Save Key Step */}
          {step === 'download' && (
            <div className='space-y-4'>
              <div className="flex size-16 text-4xl bg-primary/10 rounded-full items-center justify-center justify-self-center">
                🔑
              </div>

              <div className="relative">
                <Input
                  type={showKey ? "text" : "password"}
                  value={nsec}
                  readOnly
                  className="pr-10 font-mono"
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
                className="w-full h-12 px-9"
                onClick={handleContinue}
              >
                Continue
              </Button>

              <div className='mx-auto max-w-sm'>
                <div className='p-3 bg-amber-50 dark:bg-amber-950/20 rounded-lg border border-amber-200 dark:border-amber-800'>
                  <div className='flex items-center gap-2 mb-1'>
                    <span className='text-xs font-semibold text-amber-800 dark:text-amber-200'>
                      Important Warning
                    </span>
                  </div>
                  <p className='text-xs text-amber-900 dark:text-amber-300'>
                    This key is your primary and only means of accessing your account. Store it safely and securely.
                  </p>
                </div>
              </div>
            </div>
          )}

          {/* Profile Step */}
          {step === 'profile' && (
            <div className='space-y-4'>
              <div className='space-y-2'>
                <Label htmlFor='signup-name'>Name</Label>
                <Input
                  id='signup-name'
                  value={name}
                  onChange={(e) => setName(e.target.value)}
                  placeholder='How should people know you?'
                  maxLength={64}
                />
              </div>
              <div className='space-y-2'>
                <Label htmlFor='signup-about'>About</Label>
                <Textarea
                  id='signup-about'
                  value={about}
                  onChange={(e) => setAbout(e.target.value)}
                  placeholder='A few words about you (optional)'
                  maxLength={500}
                />
              </div>

              <div className='space-y-2'>
                <Button className='w-full' onClick={() => finishSignup(false)} disabled={isPublishing}>
                  {isPublishing ? <><Loader2 className="size-4 mr-2 animate-spin" /> Creating Profile…</> : 'Create profile'}
                </Button>
                <Button variant='outline' className='w-full' onClick={() => finishSignup(true)} disabled={isPublishing}>
                  Skip for now
                </Button>
              </div>
            </div>
          )}
        </div>
      </DialogContent>
    </Dialog>
  );
};

export default SignupDialog;
