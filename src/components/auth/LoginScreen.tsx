// NOTE: This file is stable and usually should not be modified.
// It is important that all functionality in this file is preserved, and should only be modified if explicitly requested.

import React, { useRef, useState, useEffect, useCallback } from 'react';
import { createPortal } from 'react-dom';
import { AlertTriangle, ChevronDown, ExternalLink, FileUp, Loader2, QrCode } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { ArmadaKey } from '@/components/brand/ArmadaCrest';
import { WizardShell } from '@/components/onboarding/WizardShell';
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
import { AndroidSignerOptions } from '@/components/auth/AndroidSignerOptions';
import { getNsecCredential } from '@/lib/credentialManager';
import { useLoggedInAccounts } from '@/hooks/useLoggedInAccounts';
import { APP_NAME } from '@/lib/platform';
import { shareOrigin } from '@/lib/shareOrigin';
import { withConnectPerms } from "@/lib/nostrConnectPerms";
import { useIsMobile } from '@/hooks/useIsMobile';

interface LoginScreenProps {
  isOpen: boolean;
  onClose: () => void;
  onLogin: () => void;
  onSignupClick?: () => void;
}

// bech32 charset (no b, i, o, 1 or uppercase), so a mistyped key fails here.
const validateNsec = (nsec: string) => {
  return /^nsec1[qpzry9x8gf2tvdw0s3jn54khce6mua7l]{58}$/.test(nsec);
};

// Input starting with nsec1 is almost always a truncated paste; say so.
const nsecRejectionMessage = (input: string) => {
  return input.startsWith('nsec1')
    ? "That doesn't look like a complete secret key. Check you copied the whole nsec."
    : 'Enter a secret key starting with nsec1, or a bunker:// URI.';
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
 * Full-screen login in the signup wizard's chrome ({@link WizardShell}). With
 * `onSignupClick` (opened from "Join"), "Create account" is the primary action
 * and login methods sit under an "or log in" divider. One smart input takes an
 * nsec or bunker:// URI. Driven by `isOpen` (not conditionally mounted) so the
 * handshake effects can abort cleanly on close.
 */
const LoginScreen: React.FC<LoginScreenProps> = ({ isOpen, onClose, onLogin, onSignupClick }) => {
  // On the APK the WebView origin is unreachable from the signer's browser, so
  // use the public deployment; its verified App Link reopens the app (#44).
  const callbackOrigin = shareOrigin();
  const [isLoading, setIsLoading] = useState(false);
  const [isFileLoading, setIsFileLoading] = useState(false);
  const [loginInput, setLoginInput] = useState('');
  const [loginError, setLoginError] = useState('');
  const [extensionError, setExtensionError] = useState('');
  const [nostrConnectParams, setNostrConnectParams] = useState<NostrConnectParams | null>(null);
  const [nostrConnectUri, setNostrConnectUri] = useState<string>('');
  const [connectError, setConnectError] = useState<string | null>(null);
  // Handshake progress; `null` until the user starts it (or after cancel/retry).
  const [connectStatus, setConnectStatus] = useState<NostrConnectStatus | null>(null);
  // Mobile only: the subscription listens as soon as params exist, so don't show
  // progress until the user tapped "Open signer app".
  const [hasOpenedSigner, setHasOpenedSigner] = useState(false);
  const [showQr, setShowQr] = useState(false);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const abortControllerRef = useRef<AbortController | null>(null);
  const login = useLoginActions();
  const { currentUser } = useLoggedInAccounts();

  // Stable refs so parents' inline callbacks don't re-run the listening effect.
  const onLoginRef = useRef(onLogin);
  const onCloseRef = useRef(onClose);
  const loginRef = useRef(login);
  useEffect(() => { onLoginRef.current = onLogin; }, [onLogin]);
  useEffect(() => { onCloseRef.current = onClose; }, [onClose]);
  useEffect(() => { loginRef.current = login; }, [login]);

  const isMobile = useIsMobile();
  const hasExtension = 'nostr' in window;

  // Returns the URI so the mobile deeplink can use it immediately.
  const generateConnectSession = useCallback((): string => {
    const relayUrls = login.getRelayUrls();
    const params = generateNostrConnectParams(relayUrls);
    const isMobileDevice = typeof navigator !== 'undefined' && /Android|iPhone|iPad|iPod/i.test(navigator.userAgent);
    const uri = withConnectPerms(generateNostrConnectURI(params, {
      name: APP_NAME,
      callback: isMobileDevice ? `${callbackOrigin}/remoteloginsuccess` : undefined,
    }));
    setNostrConnectParams(params);
    setNostrConnectUri(uri);
    setConnectError(null);
    return uri;
  }, [login, callbackOrigin]);

  // Deps limited to `nostrConnectParams`: re-running on parent renders would
  // cancel an in-flight subscription and swallow the signer's approval.
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
        // Already aborted by the isOpen effect: don't re-close.
        if (controller.signal.aborted) return;
        onLoginRef.current();
        onCloseRef.current();
      } catch (error) {
        if (error instanceof Error && error.name === 'AbortError') return;
        if (controller.signal.aborted) return;
        console.error('Nostrconnect failed:', error);
        setConnectStatus(null);
        setConnectError(error instanceof Error ? error.message : String(error));
      }
    };

    startListening();

    // No cleanup on purpose; cancellation is explicit (isOpen effect, handleConnectCancel).
  }, [nostrConnectParams]);

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

  const handleShowQr = () => {
    if (!nostrConnectParams) generateConnectSession();
    setShowQr(true);
  };

  // Opens a signer app like Amber. Flip into the progress view *synchronously*
  // so it's showing when the user returns.
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

    // Let the UI update before the synchronous login call.
    setTimeout(async () => {
      try {
        await login.nsec(key);
        onLogin();
        onClose();
      } catch {
        setLoginError("Failed to login with this key. Please check that it's correct.");
        setIsLoading(false);
      }
    }, 50);
  };

  // An nsec logs in locally; a bunker:// URI connects a NIP-46 signer.
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
      setLoginError(nsecRejectionMessage(input));
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

  // Web Credential Management API: Chromium (incl. Android WebView via Google
  // Password Manager) only; inert on WebKit. Skipped when signed in: in "Add
  // another account" `mediation: "optional"` would silently re-log the same account.
  useEffect(() => {
    if (!isOpen || currentUser) return;
    let cancelled = false;

    getNsecCredential().then((cred) => {
      if (cancelled || !cred) return;
      if (validateNsec(cred.nsec)) {
        executeLogin(cred.nsec);
      }
    });

    return () => { cancelled = true; };
  }, [isOpen]); // eslint-disable-line react-hooks/exhaustive-deps

  // Mobile: show progress once "Open signer app" was tapped. Desktop: keep the
  // QR (still scannable) until the signer acknowledges.
  const showProgressView = connectStatus !== null && (
    connectStatus === 'getting-public-key' ||
    (isMobile && hasOpenedSigner)
  );

  if (!isOpen) return null;

  // Doubles as the shell's step key so view changes replay the enter animation.
  const view = connectError ? 'error' : showProgressView ? 'progress' : showQr ? 'qr' : 'form';

  // From "Join", creating an account is primary; from "Add another account"
  // there's nothing to create. Form view only.
  const joinMode = !!onSignupClick && view === 'form';

  return createPortal(
    // `total={0}` drops the progress bar. z-[255] clears Radix dialogs (z-[250])
    // but stays under dropdown content (z-[260]).
    // Portalled to <body>: a transformed ancestor (SwipeReveal) would otherwise
    // become the containing block for `position: fixed` and clip the takeover.
    <WizardShell index={0} total={0} stepKey={view} zClassName="z-[255]" onClose={onClose}>
      <div className="flex flex-col items-center gap-8 text-center">
        <ArmadaKey size={110} />

        <div className="space-y-2.5">
          <h1 className="font-mono text-2xl font-bold lowercase tracking-tight text-foreground">
            {joinMode ? `join ${APP_NAME.toLowerCase()}` : 'log in'}
          </h1>
          {joinMode && (
            <p className="text-sm leading-relaxed text-muted-foreground">
              Create a new account, or log in with a key you already have.
            </p>
          )}
        </div>

        <div className='w-full space-y-4 text-left'>
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
              {joinMode && onSignupClick && (
                <div className='space-y-4'>
                  <Button
                    type='button'
                    size='lg'
                    className='h-12 w-full clip-corner-lg text-base font-medium'
                    onClick={() => { onClose(); onSignupClick(); }}
                  >
                    Create account
                  </Button>
                  <div className='flex items-center gap-3'>
                    <div className='h-px flex-1 bg-border' />
                    <span className='text-xs uppercase tracking-wider text-muted-foreground'>
                      or log in
                    </span>
                    <div className='h-px flex-1 bg-border' />
                  </div>
                </div>
              )}

              {/* Capacitor Android only, with a signer installed. */}
              <AndroidSignerOptions onLogin={() => { onLogin(); onClose(); }} />

              {hasExtension && (
                <div className="space-y-3">
                  {extensionError && (
                    <Alert variant="destructive">
                      <AlertTriangle className="h-4 w-4" />
                      <AlertDescription>{extensionError}</AlertDescription>
                    </Alert>
                  )}
                  <Button
                    variant={joinMode ? 'secondary' : 'default'}
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
                    className={`pr-12 clip-corner-lg bg-background border-transparent ${
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
                        className='absolute right-0 top-0 h-full w-10 touch:w-11 clip-corner-lg text-muted-foreground hover:bg-muted/60'
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

                {/* Secondary so the screen has one primary action. */}
                <Button
                  type='submit'
                  size='lg'
                  variant={joinMode ? 'secondary' : 'default'}
                  disabled={isLoading || isFileLoading || !loginInput.trim()}
                  className='w-full clip-corner-lg'
                >
                  {isLoading ? 'Logging in…' : 'Log in'}
                </Button>
              </form>
            </>
          )}
        </div>
      </div>
    </WizardShell>,
    document.body,
  );
};

export default LoginScreen;
