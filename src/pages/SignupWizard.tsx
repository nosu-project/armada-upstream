import { useNostr } from "@nostrify/react";
import { useEffect, useRef, useState, type ReactNode } from "react";
import { useNavigate } from "react-router-dom";
import { finalizeEvent, nip19 } from "nostr-tools";

import type { NostrEvent } from "@nostrify/nostrify";

import { ArmadaIdentity } from "@/components/brand/ArmadaCrest";
import { ProfileStepBody } from "@/components/onboarding/ProfileStep";
import { WizardShell } from "@/components/onboarding/WizardShell";
import {
  GenerateStepBody,
  SaveKeyStepBody,
  useSignupKey,
} from "@/components/onboarding/signupSteps";
import { Button } from "@/components/ui/button";
import { useAppContext } from "@/hooks/useAppContext";
import { useCurrentUser } from "@/hooks/useCurrentUser";
import { suppressNextSyncGate } from "@/hooks/useFreshLogin";
import { setOnboardingActive } from "@/hooks/useOnboarding";
import { APP_CONFIG_STORAGE_KEY, seedAccountConfig } from "@/lib/activeAccount";
import { clearPendingJoin, peekPendingJoin, type JoinLink } from "@/lib/joinLink";
import { publishSignedEventToRelays, uniqueRelayUrls } from "@/lib/nip65";
import { markRelayRecoveryPromptShown } from "@/lib/relayRecoveryPrompt";
import { useLoginActions } from "@/hooks/useLoginActions";
import { toast } from "@/hooks/useToast";

/**
 * Full-page account-creation wizard (Ditto-style): generate key → save it
 * (Continue only after a successful backup) → profile (skippable). Step bodies
 * are shared with {@link SignupDialog} (`signupSteps.tsx`); this adds the
 * progress bar, a `/join` referral confirmation, the kind-10002 relay-list seed,
 * and an exit onto /discover. Lazy-loaded: the landing doesn't need its deps.
 */

const WIZARD_STEPS = ["generate", "download", "profile"] as const;
type WizardStep = (typeof WIZARD_STEPS)[number];

/** The shared wizard chrome, positioned within this wizard's step sequence. */
function SignupShell({ step, maxWidth, onBack, onClose, children }: {
  step: WizardStep;
  /** Column width cap (a `max-w-*` class). Text-heavy steps go a size up. */
  maxWidth?: "max-w-sm" | "max-w-md" | "max-w-xl";
  onBack?: () => void;
  onClose?: () => void;
  children: ReactNode;
}) {
  return (
    <WizardShell
      index={WIZARD_STEPS.indexOf(step)}
      total={WIZARD_STEPS.length}
      stepKey={step}
      maxWidth={maxWidth}
      onBack={onBack}
      onClose={onClose}
    >
      {children}
    </WizardShell>
  );
}

export interface SignupWizardProps {
  /** Leave without finishing (back off step one, close, or declining a join link). */
  onExit: () => void;
}

export function SignupWizard({ onExit }: SignupWizardProps) {
  const { config } = useAppContext();
  const { user } = useCurrentUser();
  const { nostr } = useNostr();
  const navigate = useNavigate();
  const login = useLoginActions();
  const signupKey = useSignupKey();
  // A stashed `/join` link: the operator's relays to seed onto. Its
  // confirmation screen precedes key generation.
  const [join, setJoin] = useState<JoinLink | undefined>(() => peekPendingJoin());
  // `null` is the join confirmation step.
  const [step, setStep] = useState<WizardStep | null>(() => (peekPendingJoin() ? null : "generate"));
  const dismissJoin = () => {
    clearPendingJoin();
    setJoin(undefined);
    onExit();
  };
  // Keeps the save step rendered while `login.nsec` persists (otherwise
  // neither branch matches and nothing renders).
  const [loggingIn, setLoggingIn] = useState(false);

  // Clear on any exit; it's set synchronously at login (handleContinue) to beat the race.
  useEffect(() => () => setOnboardingActive(false), []);

  // Relay list for the just-minted key, published post-login so NIP-42 AUTH
  // relays get the now-active signer. See handleContinue for why it's safe.
  const pendingRelayList = useRef<{ pubkey: string; event: NostrEvent; relays: string[] } | null>(null);
  useEffect(() => {
    const pending = pendingRelayList.current;
    if (!pending || user?.pubkey !== pending.pubkey) return;
    pendingRelayList.current = null;
    void publishSignedEventToRelays(nostr, pending.event, pending.relays, 8_000);
  }, [user?.pubkey, nostr]);

  const handleGenerate = () => {
    signupKey.generate();
    setStep("download");
  };

  // Exit onto Discover: browsing live communities beats a blank create form.
  const finishOnboarding = () => {
    navigate("/discover");
  };

  // Log in as the new account (only reachable once the key is backed up).
  const handleContinue = async () => {
    if (loggingIn) return;
    const { identity, nsec } = signupKey;
    // Brand-new account: skip the post-login SyncGate, whose overlay (z-100)
    // would cover the wizard (z-50).
    if (identity) {
      suppressNextSyncGate(identity.pubkey);
      markRelayRecoveryPromptShown(identity.pubkey);
    }

    const homeRelays = uniqueRelayUrls(join ? join.relays : config.appRelays);

    // Seed THIS account's scoped config directly; `updateConfig` still points
    // at the outgoing account until the login commits.
    const configSeed: Record<string, unknown> = { appRelays: homeRelays };

    if (join) clearPendingJoin();

    // The ONE exception to never-auto-publish: a key minted moments ago has
    // provably no existing list to overwrite. Must never run for existing keys.
    // Signed now; fanned out post-login by the effect above.
    if (identity && homeRelays.length > 0) {
      try {
        const sk = nip19.decode(nsec).data as Uint8Array;
        const event = finalizeEvent(
          {
            kind: 10002,
            created_at: Math.floor(Date.now() / 1000),
            tags: homeRelays.map((url) => ["r", url]),
            content: "",
          },
          sk,
        );
        pendingRelayList.current = { pubkey: identity.pubkey, event, relays: homeRelays };
        configSeed.relayMetadata = {
          relays: homeRelays.map((url) => ({ url, read: true, write: true })),
          updatedAt: event.created_at,
          eventId: event.id,
          pubkey: identity.pubkey,
        };
      } catch {
        // best effort; the account still works on the app relays
      }
    }

    if (identity) {
      seedAccountConfig(APP_CONFIG_STORAGE_KEY, identity.pubkey, configSeed);
    }
    // Set BEFORE login so the first commit exposing the user already suppresses
    // the web-push opt-in and native notification step.
    setOnboardingActive(true);
    setLoggingIn(true);
    try {
      // Awaited: advancing before the login persists blanks the wizard and
      // leaves a rejected persist unhandled for a key only just backed up.
      await login.nsec(nsec);
    } catch {
      setLoggingIn(false);
      setOnboardingActive(false);
      toast({
        title: "Couldn't sign in",
        description:
          "Your key was created but could not be saved to this device. Keep your backup and try again.",
        variant: "destructive",
      });
      return;
    }
    setStep("profile");
  };

  if (!user && step === "generate") {
    return (
      <SignupShell step="generate" onBack={onExit} onClose={onExit}>
        <GenerateStepBody onGenerate={handleGenerate} />
      </SignupShell>
    );
  }

  if (!user && step === "download") {
    return (
      <SignupShell
        step="download"
        onBack={() => setStep("generate")}
        onClose={onExit}
      >
        <SaveKeyStepBody signupKey={signupKey} loggingIn={loggingIn} onContinue={handleContinue} />
      </SignupShell>
    );
  }

  // No back arrow: the account exists now, and back would loop.
  if (user && step === "profile") {
    return (
      <SignupShell step="profile" onClose={onExit}>
        <ProfileStepBody
          expectedPubkey={signupKey.identity?.pubkey}
          onFinish={finishOnboarding}
        />
      </SignupShell>
    );
  }

  // Join link: name the operator and relays, then hand off to key generation
  // (relays are adopted at account creation, not here).
  if (!user && join && step === null) {
    const host = (url: string) => url.replace(/^wss?:\/\//i, "").replace(/\/+$/, "");
    return (
      <WizardShell index={0} total={0} stepKey="join" onClose={dismissJoin}>
        <div className="flex flex-col items-center gap-6 text-center">
          <ArmadaIdentity size={96} />
          <div className="space-y-2.5">
            <h1 className="font-mono text-2xl font-bold lowercase tracking-tight text-foreground">
              join {join.name ?? host(join.relays[0])}
            </h1>
            <p className="text-sm leading-relaxed text-muted-foreground">
              You've been invited to create a new Armada account hosted on
              {join.relays.length === 1 ? " this relay" : " these relays"}. Your account's data
              will live here so it's ready wherever you sign in. You can change this later in
              Settings.
            </p>
          </div>
          <div className="w-full space-y-1 clip-corner-lg bg-secondary/50 p-3 text-left">
            {join.relays.map((url) => (
              <p key={url} className="break-all font-mono text-xs text-foreground">
                {host(url)}
              </p>
            ))}
          </div>
          <div className="w-full space-y-2">
            <Button
              size="lg"
              className="h-12 w-full clip-corner-lg text-base font-medium"
              onClick={() => setStep("generate")}
            >
              Create my account
            </Button>
            <Button
              variant="ghost"
              className="w-full text-muted-foreground"
              onClick={dismissJoin}
            >
              Not now
            </Button>
          </div>
        </div>
      </WizardShell>
    );
  }

  // Nothing matches (closed, or login landed mid signed-out step): the landing route re-decides.
  return null;
}

export default SignupWizard;
