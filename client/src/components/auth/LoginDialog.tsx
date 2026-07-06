// NOTE: This file is stable and usually should not be modified.
// It is important that all functionality in this file is preserved, and should only be modified if explicitly requested.

import React, { useRef, useState, useEffect, useCallback } from 'react';
import { AlertTriangle, ChevronDown, ExternalLink, FileUp, KeyRound, Loader2, QrCode } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Dialog, ChromeDialogContent } from "@/components/ui/dialog";
import { Alert, AlertDescription } from '@/components/ui/alert';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { QRCodeCanvas } from '@/components/ui/qrcode';
import {
  useLoginActions,
  generateNostrConnectParams,
  generateNostrConnectURI,
  type NostrConnectParams,
  type NostrConnectStatus,
} from '@/hooks/useLoginActions';
import { getNsecCredential } from '@/lib/credentialManager';
import { APP_NAME } from '@/lib/platform';
import { useIsMobile } from '@/hooks/useIsMobile';

interface LoginDialogProps {
  isOpen: boolean;
  onClose: () => void;
  onLogin: () => void;
  onSignupClick?: () => void;
}

const validateNsec = (nsec: string) => {
  return /^nsec1[a-zA-Z0-9]{58}$/.test(nsec);
};

const validateBunkerUri = (uri: string) => {
  return uri.startsWith('bunker://');
};

const connectStatusLabel = (status: NostrConnectStatus | null): string => {
  switch (status) {
    case 'awaiting-connect':
      return 'Waiting for signer connection…';
    case 'getting-public-key':
      return 'Getting public key…';
    default:
      return '';
  }
};

/**
 * The login options box, in the single-smart-input format: one field that
 * accepts an nsec or a bunker:// URI, with the secondary methods (key file,
 * remote signer via QR/deeplink) tucked into a dropdown embedded at the
 * input's right edge. The remote-signer handshake swaps the form for a
 * QR / progress / error view inside the same dialog.
 */
const LoginDialog: React.FC<LoginDialogProps> = ({ isOpen, onClose, onLogin, onSignupClick }) => {
  const shareOrigin = window.location.origin;
  const [isLoading, setIsLoading] = useState(false);
  const [isFileLoading, setIsFileLoading] = useState(false);
  const [loginInput, setLoginInput] = useState('');
  const [loginError, setLoginError] = useState('');
  const [extensionError, setExtensionError] = useState('');
  const [nostrConnectParams, setNostrConnectParams] = useState<NostrConnectParams | null>(null);
  const [nostrConnectUri, setNostrConnectUri] = useState<string>('');
  const [connectError, setConnectError] = useState<string | null>(null);
  // Progress status for the nostrconnect handshake. `null` means the user
  // hasn't kicked off the handshake yet (or they canceled/retried). Once the
  // handshake advances we swap the QR/form for a spinner with a live-updating
  // status line, so the user knows something is happening while the signer
  // app is working.
  const [connectStatus, setConnectStatus] = useState<NostrConnectStatus | null>(null);
  // Tracks whether the user has explicitly initiated the handshake from the
  // mobile UI (tapped "Open signer app"). The subscription itself starts
  // listening as soon as params are generated — without this flag we'd flip
  // the dialog into the progress view before the user has done anything.
  // Desktop doesn't need this: it stays on the QR until the handshake
  // advances past `awaiting-connect`.
  const [hasOpenedSigner, setHasOpenedSigner] = useState(false);
  // Desktop remote-signer view: show the QR in place of the form.
  const [showQr, setShowQr] = useState(false);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const abortControllerRef = useRef<AbortController | null>(null);
  const login = useLoginActions();

  // Keep stable refs to props/actions so the listening effect below doesn't
  // re-run on every parent render (parents typically pass inline arrow
  // functions for onLogin/onClose, and useLoginActions returns a fresh object
  // each render).
  const onLoginRef = useRef(onLogin);
  const onCloseRef = useRef(onClose);
  const loginRef = useRef(login);
  useEffect(() => { onLoginRef.current = onLogin; }, [onLogin]);
  useEffect(() => { onCloseRef.current = onClose; }, [onClose]);
  useEffect(() => { loginRef.current = login; }, [login]);

  // Check if on mobile device
  const isMobile = useIsMobile();
  // Check if extension is available
  const hasExtension = 'nostr' in window;

  // Generate nostrconnect params (sync) - just creates the QR code data.
  // Returns the URI so callers (the mobile deeplink) can use it immediately.
  const generateConnectSession = useCallback((): string => {
    const relayUrls = login.getRelayUrls();
    const params = generateNostrConnectParams(relayUrls);
    const isMobileDevice = typeof navigator !== 'undefined' && /Android|iPhone|iPad|iPod/i.test(navigator.userAgent);
    const uri = generateNostrConnectURI(params, {
      name: APP_NAME,
      callback: isMobileDevice ? `${shareOrigin}/remoteloginsuccess` : undefined,
    });
    setNostrConnectParams(params);
    setNostrConnectUri(uri);
    setConnectError(null);
    return uri;
  }, [login, shareOrigin]);

  // Start listening for connection (async) - runs once after params are set.
  //
  // Deps are intentionally limited to `nostrConnectParams` so that parent
  // re-renders (which produce fresh onLogin/onClose closures and a fresh
  // `login` object from useLoginActions) do NOT tear down an in-flight
  // subscription. Previously this effect re-ran on every render, repeatedly
  // flipping a local `cancelled` flag to true and causing a successful
  // nostrconnect response to be silently swallowed after the signer approved.
  useEffect(() => {
    if (!nostrConnectParams) return;

    const startListening = async () => {
      const controller = new AbortController();
      abortControllerRef.current = controller;

      try {
        await loginRef.current.nostrconnect(
          nostrConnectParams,
          controller.signal,
          (status) => {
            if (controller.signal.aborted) return;
            setConnectStatus(status);
          },
        );
        // If the dialog was explicitly closed (handled by the isOpen effect,
        // which aborts the controller), don't try to re-close it. Otherwise,
        // the user is logged in — close the dialog and notify the parent.
        if (controller.signal.aborted) return;
        onLoginRef.current();
        onCloseRef.current();
      } catch (error) {
        // AbortError means we intentionally aborted (dialog closed or retry)
        if (error instanceof Error && error.name === 'AbortError') return;
        if (controller.signal.aborted) return;
        console.error('Nostrconnect failed:', error);
        setConnectStatus(null);
        setConnectError(error instanceof Error ? error.message : String(error));
      }
    };

    startListening();

    // No cleanup here: we do NOT want a re-render-triggered effect teardown
    // to cancel the in-flight subscription. Cancellation is handled
    // explicitly by the `isOpen` effect and by handleConnectCancel().
  }, [nostrConnectParams]);

  // Clean up on close
  useEffect(() => {
    if (!isOpen) {
      setLoginInput('');
      setLoginError('');
      setExtensionError('');
      setNostrConnectParams(null);
      setNostrConnectUri('');
      setConnectError(null);
      setConnectStatus(null);
      setHasOpenedSigner(false);
      setShowQr(false);
      if (abortControllerRef.current) {
        abortControllerRef.current.abort();
      }
    }
  }, [isOpen]);

  // Cancel/retry the remote-signer handshake and return to the form.
  const handleConnectCancel = useCallback(() => {
    if (abortControllerRef.current) {
      abortControllerRef.current.abort();
    }
    setNostrConnectParams(null);
    setNostrConnectUri('');
    setConnectError(null);
    setConnectStatus(null);
    setHasOpenedSigner(false);
    setShowQr(false);
  }, []);

  // Desktop: generate a session and show the QR view.
  const handleShowQr = () => {
    if (!nostrConnectParams) generateConnectSession();
    setShowQr(true);
  };

  // Mobile: open the nostrconnect URI in the system — this launches a signer
  // app like Amber if installed. Flip into the progress view *synchronously*
  // before navigating so that when the user returns from the signer app, the
  // dialog is already showing "Waiting for signer connection…" — not the
  // original form they're worried they need to re-tap.
  const handleOpenSignerApp = () => {
    const uri = nostrConnectUri || generateConnectSession();
    setHasOpenedSigner(true);
    window.location.href = uri;
  };

  const handleExtensionLogin = async () => {
    setIsLoading(true);
    setExtensionError('');

    try {
      if (!('nostr' in window)) {
        throw new Error('Nostr extension not found. Please install a NIP-07 extension.');
      }
      await login.extension();
      onLogin();
      onClose();
    } catch (e: unknown) {
      const error = e as Error;
      console.error('Extension login failed:', error);
      setExtensionError(error instanceof Error ? error.message : 'Extension login failed');
    } finally {
      setIsLoading(false);
    }
  };

  const executeLogin = (key: string) => {
    setIsLoading(true);
    setLoginError('');

    // Use a timeout to allow the UI to update before the synchronous login call
    setTimeout(() => {
      try {
        login.nsec(key);
        onLogin();
        onClose();
      } catch {
        setLoginError("Failed to login with this key. Please check that it's correct.");
        setIsLoading(false);
      }
    }, 50);
  };

  // One input, two shapes: an nsec logs in locally, a bunker:// URI connects
  // a NIP-46 signer.
  const handleLogin = async () => {
    const input = loginInput.trim();
    if (!input) {
      setLoginError('Please enter your secret key or bunker URI');
      return;
    }

    if (validateBunkerUri(input)) {
      setIsLoading(true);
      setLoginError('');
      try {
        await login.bunker(input);
        onLogin();
        onClose();
        // Clear the URI from memory
        setLoginInput('');
      } catch {
        setLoginError('Failed to connect. Check the bunker URI.');
      } finally {
        setIsLoading(false);
      }
      return;
    }

    if (!validateNsec(input)) {
      setLoginError('Enter a secret key starting with nsec1, or a bunker:// URI.');
      return;
    }
    executeLogin(input);
  };

  const handleFileUpload = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;

    setIsFileLoading(true);
    setLoginError('');

    const reader = new FileReader();
    reader.onload = (event) => {
      setIsFileLoading(false);
      const content = event.target?.result as string;
      const trimmedContent = content?.trim();
      if (trimmedContent && validateNsec(trimmedContent)) {
        executeLogin(trimmedContent);
      } else if (trimmedContent) {
        setLoginError('File does not contain a valid secret key.');
      } else {
        setLoginError('Could not read file content.');
      }
    };
    reader.onerror = () => {
      setIsFileLoading(false);
      setLoginError('Failed to read file.');
    };
    reader.readAsText(file);
  };

  // Progressive enhancement: attempt to retrieve a stored credential from the
  // platform's password manager when the dialog opens.
  // On Capacitor iOS this shows the iCloud Keychain credential picker.
  // On Chromium browsers this shows the native credential chooser.
  useEffect(() => {
    if (!isOpen) return;
    let cancelled = false;

    getNsecCredential().then((cred) => {
      if (cancelled || !cred) return;
      if (validateNsec(cred.nsec)) {
        executeLogin(cred.nsec);
      }
    });

    return () => { cancelled = true; };
  }, [isOpen]); // eslint-disable-line react-hooks/exhaustive-deps

  // Decide whether to render the progress view in place of the QR/form.
  // Mobile: flip in as soon as the user taps "Open signer app" (tracked by
  // `hasOpenedSigner`) so they see feedback the moment they return from the
  // signer. Desktop: keep the QR visible while waiting for the signer (it's
  // still actionable — they might scan it with a different device) and only
  // swap once the signer has acknowledged and we're fetching the pubkey.
  const showProgressView = connectStatus !== null && (
    connectStatus === 'getting-public-key' ||
    (isMobile && hasOpenedSigner)
  );

  return (
    <Dialog open={isOpen} onOpenChange={onClose}>
      <ChromeDialogContent title="Log in" className="max-w-[95vw] sm:max-w-sm" contentClassName="max-h-[90dvh] overflow-y-auto">
        <div className="flex flex-col items-center gap-2 text-center">
          <div className="flex size-12 items-center justify-center clip-corner-lg bg-primary/15 text-primary">
            <KeyRound className="size-6" />
          </div>
          <h2 className="chrome-dialog-title font-mono font-bold lowercase tracking-tight text-foreground">
            log in
          </h2>
        </div>

        <div className='mt-6 space-y-4 overflow-y-auto'>
          {onSignupClick && !connectError && !showProgressView && !showQr && (
            <p className="text-center text-sm text-muted-foreground">
              New here?{' '}
              <button
                type="button"
                onClick={() => { onClose(); onSignupClick(); }}
                className="text-primary hover:underline font-medium"
              >
                Create account
              </button>
            </p>
          )}

          {connectError ? (
            <div className='flex flex-col items-center space-y-3 py-4'>
              <p className='text-sm text-destructive text-center'>{connectError}</p>
              <Button variant='outline' onClick={handleConnectCancel} className='clip-corner-lg'>
                Try again
              </Button>
            </div>
          ) : showProgressView ? (
            <div className='flex flex-col items-center space-y-4 py-6 w-full'>
              <Loader2 className='w-8 h-8 animate-spin text-primary' />
              <p className='text-sm text-muted-foreground text-center min-h-[1.25rem]'>
                {connectStatusLabel(connectStatus) || 'Waiting for your signer…'}
              </p>
              <button
                type='button'
                onClick={handleConnectCancel}
                className='text-sm text-primary hover:underline underline-offset-4 font-medium'
              >
                Cancel
              </button>
            </div>
          ) : showQr ? (
            <div className='flex flex-col items-center space-y-4'>
              {nostrConnectUri ? (
                <div className='p-4 bg-white dark:bg-white clip-corner-lg'>
                  <QRCodeCanvas value={nostrConnectUri} size={180} level='M' />
                </div>
              ) : (
                <div className='flex items-center justify-center h-[180px]'>
                  <Loader2 className='w-8 h-8 animate-spin text-muted-foreground' />
                </div>
              )}
              <p className='text-sm text-muted-foreground text-center'>
                Scan with a signer app to log in.
              </p>
              <button
                type='button'
                onClick={handleConnectCancel}
                className='text-sm text-muted-foreground hover:text-foreground'
              >
                Back
              </button>
            </div>
          ) : (
            <>
              {/* Extension Login Button - shown if extension is available */}
              {hasExtension && (
                <div className="space-y-3">
                  {extensionError && (
                    <Alert variant="destructive">
                      <AlertTriangle className="h-4 w-4" />
                      <AlertDescription>{extensionError}</AlertDescription>
                    </Alert>
                  )}
                  <Button
                    className="w-full h-12 clip-corner-lg"
                    onClick={handleExtensionLogin}
                    disabled={isLoading}
                  >
                    {isLoading ? 'Logging in...' : 'Log in with Extension'}
                  </Button>
                  <div className="flex items-center gap-3">
                    <div className="h-px flex-1 bg-border" />
                    <span className="text-xs uppercase tracking-wider text-muted-foreground">or</span>
                    <div className="h-px flex-1 bg-border" />
                  </div>
                </div>
              )}

              <form onSubmit={(e) => { e.preventDefault(); handleLogin(); }} className='space-y-3'>
                <div className='relative'>
                  <Input
                    type='password'
                    value={loginInput}
                    onChange={(e) => {
                      setLoginInput(e.target.value);
                      if (loginError) setLoginError('');
                    }}
                    placeholder='nsec1… or bunker://…'
                    autoComplete='off'
                    className={`pr-12 clip-corner-lg bg-background/40 border-transparent ${
                      loginError ? 'border-destructive focus-visible:ring-destructive' : ''
                    }`}
                  />
                  <input
                    type='file'
                    accept='.txt'
                    className='hidden'
                    ref={fileInputRef}
                    onChange={handleFileUpload}
                  />
                  <DropdownMenu>
                    <DropdownMenuTrigger asChild>
                      <Button
                        type='button'
                        variant='ghost'
                        size='icon'
                        className='absolute right-0 top-0 h-full w-10 rounded-l-none border-l border-input bg-muted/40 hover:bg-muted'
                        title='More login options'
                        aria-label='More login options'
                      >
                        <ChevronDown className='h-4 w-4 text-muted-foreground' />
                      </Button>
                    </DropdownMenuTrigger>
                    <DropdownMenuContent align='end'>
                      <DropdownMenuItem
                        onSelect={() => fileInputRef.current?.click()}
                        disabled={isFileLoading}
                        className='flex items-center gap-2 cursor-pointer'
                      >
                        <FileUp className='h-4 w-4' />
                        Select key file
                      </DropdownMenuItem>
                      {isMobile ? (
                        <DropdownMenuItem
                          onSelect={handleOpenSignerApp}
                          className='flex items-center gap-2 cursor-pointer'
                        >
                          <ExternalLink className='h-4 w-4' />
                          Open signer app
                        </DropdownMenuItem>
                      ) : (
                        <DropdownMenuItem
                          onSelect={handleShowQr}
                          className='flex items-center gap-2 cursor-pointer'
                        >
                          <QrCode className='h-4 w-4' />
                          Connect remote signer
                        </DropdownMenuItem>
                      )}
                    </DropdownMenuContent>
                  </DropdownMenu>
                </div>
                {loginError && <p className='text-sm text-destructive'>{loginError}</p>}

                <Button
                  type='submit'
                  size='lg'
                  disabled={isLoading || isFileLoading || !loginInput.trim()}
                  className='w-full clip-corner-lg'
                >
                  {isLoading ? 'Logging in…' : 'Log in'}
                </Button>
              </form>
            </>
          )}
        </div>
      </ChromeDialogContent>
    </Dialog>
  );
};

export default LoginDialog;
