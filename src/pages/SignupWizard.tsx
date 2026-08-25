import { useNostr } from "@nostrify/react";
import { useEffect, useRef, useState, type ReactNode } from "react";
import { useNavigate } from "react-router-dom";
import { finalizeEvent, nip19 } from "nostr-tools";

import type { NostrEvent } from "@nostrify/nostrify";

import { ArmadaIdentity } from "@/components/brand/ArmadaCrest";
import { WizardShell } from "@/components/onboarding/WizardShell";
import {
  GenerateStepBody,
  ProfileStepBody,
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
 * The full-page account-creation wizard, in the style of Ditto's onboarding
 * (full-screen takeover, top progress bar, one animated step at a time):
 *
 *   1. generate — a secret key is your identity; generate it.
 *   2. download — reveal the key and copy or back it up. Continue is gated on
 *      an explicit backup — a successful Copy, keyring save, or file export —
 *      so a new user can't skip past saving their only login; then log in.
 *   3. profile  — the same WYSIWYG {@link ProfileSettings} editor used in
 *      Settings, so a new user sets their name/avatar before entering any
 *      community. Skippable.
 *
 * The three step bodies are the shared ones in `signupSteps.tsx`, the same the
 * in-app {@link SignupDialog} renders; what this file adds is the landing-only
 * chrome and behavior — the progress bar, a `/join` referral confirmation step
 * ahead of all three, the default kind-10002 relay-list seed, and an exit onto
 * /discover.
 *
 * The wizard exits onto /discover: a new user browses live communities first
 * (and the Discover grid leads with a create-your-own tile), rather than
 * being pushed straight into founding a community of one.
 *
 * Nothing blocks a new user: every step past key-save is skippable.
 *
 * Split out of the landing route and loaded lazily: this pulls nostr-tools,
 * the login actions and the whole {@link ProfileSettings} editor, none of
 * which a signed-out visitor reading the landing page needs. The landing is in
 * the entry chunk; this arrives on the first tap of "Create account".
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
  /**
   * Leave the wizard without finishing it — a back arrow off the first step, a
   * close button, or declining a join link. The landing route returns.
   */
  onExit: () => void;
}

export function SignupWizard({ onExit }: SignupWizardProps) {
  const { config } = useAppContext();
  const { user } = useCurrentUser();
  const { nostr } = useNostr();
  const navigate = useNavigate();
  const login = useLoginActions();
  const signupKey = useSignupKey();
  // A pending referral/join link (a `/join` deep link stashed it before routing
  // here): the operator's relay set to seed this new account onto. Read once on
  // mount; its confirmation screen sits ahead of the key-generation step.
  const [join, setJoin] = useState<JoinLink | undefined>(() => peekPendingJoin());
  // Wizard position. `null` is the join confirmation — reachable only with a
  // pending link, which is why that is where a link starts it.
  const [step, setStep] = useState<WizardStep | null>(() => (peekPendingJoin() ? null : "generate"));
  const dismissJoin = () => {
    clearPendingJoin();
    setJoin(undefined);
    onExit();
  };
  // True while `login.nsec` is persisting the new login. The save step stays
  // rendered throughout: leaving it before the login is durable renders
  // nothing at all (neither the `!user` nor the `user` branch matches).
  const [loggingIn, setLoggingIn] = useState(false);

  // Whatever exit the wizard takes (finish, skip, or navigating onto a
  // community), it unmounts — so clear the onboarding flag here. Setting it is
  // done synchronously at login (see handleContinue) to beat the race.
  useEffect(() => () => setOnboardingActive(false), []);

  // A default NIP-65 relay list, signed for a key WE JUST MINTED, waiting to be
  // fanned to its relays once that key is the active login. Published post-login
  // (not inline in handleContinue) so relays that gate writes behind NIP-42 AUTH
  // get an answer from the now-active signer. See handleContinue for why this
  // one auto-publish is safe.
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

  // The wizard's exit: land the new user on Discover, where they can browse
  // live communities before committing to anything — the create-your-own tile
  // there is the first thing in the grid, so founding a community stays one
  // click away. Seeing the network beats being asked to build one from a
  // blank form (the classic dead-first-server trap).
  const finishOnboarding = () => {
    navigate("/discover");
  };

  // Leave the save step: log in as the new account and move to profile setup.
  // Only reachable once the key is backed up.
  const handleContinue = async () => {
    if (loggingIn) return;
    const { identity, nsec } = signupKey;
    // Brand-new account: nothing to catch up on, so skip the post-login sync
    // gate. Otherwise its full-screen overlay paints over the profile/add
    // wizard steps (SyncGate is z-100, the wizard z-50) while a network-bound
    // sync runs — on a slow phone that looks like onboarding was skipped.
    if (identity) {
      suppressNextSyncGate(identity.pubkey);
      // A brand-new account has nothing on any relay to recover, so never show
      // it the "restore your setup" prompt.
      markRelayRecoveryPromptShown(identity.pubkey);
    }

    // Where this brand-new account will live: an operator's set from a join
    // link, otherwise the app's default relays.
    const homeRelays = uniqueRelayUrls(join ? join.relays : config.appRelays);

    // Everything this step settles about the new account's config is written to
    // THAT account's own scoped blob, below, rather than through `updateConfig`
    // — which would still be pointed at the outgoing account (or at no account
    // at all) until the login commits. Config is per-account now, so an
    // existing account's relays are never rewritten by construction; the
    // previous version had to special-case `logins.length` to get that.
    const configSeed: Record<string, unknown> = { appRelays: homeRelays };

    if (join) clearPendingJoin();

    // Publish a default NIP-65 relay list for the key we just generated. This
    // is the ONE safe exception to the never-auto-publish rule: a key minted
    // moments ago has provably never published anything, so there is no
    // existing list an empty/failed read could be mistaken for and overwrite —
    // the ambiguity the rule guards against cannot arise. It only ever runs
    // here (the login path for EXISTING keys must never reach this), and it
    // makes the new account discoverable on its home relays instead of relying
    // on shared app-relay defaults. Signed now with the key in hand; fanned
    // out post-login by the effect above. Skipped when there is nothing to
    // declare (e.g. a build with empty app-relay defaults).
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
        // Best effort: the account still works on its local app relays.
      }
    }

    if (identity) {
      seedAccountConfig(APP_CONFIG_STORAGE_KEY, identity.pubkey, configSeed);
    }
    // Mark onboarding in progress BEFORE login so it's already true on the
    // commit that first exposes the user — otherwise the headless web-push
    // opt-in (and the native notification step) would enqueue and paint over
    // the profile step. Cleared when this wizard unmounts.
    setOnboardingActive(true);
    setLoggingIn(true);
    try {
      // Awaited: `login.nsec` persists the login asynchronously (and, with an
      // account already active, performs the whole switch). Advancing before
      // it resolves moves to a step that renders on `user` — so the wizard
      // blanks until the login commits — and leaves a rejected persist with no
      // handler at all, for a key whose only copy the user was just told to
      // back up.
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

  // ── Wizard step 1: generate the key ─────────────────────────────────────
  if (!user && step === "generate") {
    return (
      <SignupShell step="generate" onBack={onExit} onClose={onExit}>
        <GenerateStepBody onGenerate={handleGenerate} />
      </SignupShell>
    );
  }

  // ── Wizard step 2: save the key ─────────────────────────────────────────
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

  // ── Wizard step 3: profile setup ────────────────────────────────────────
  // No back arrow: the previous step created the account, and there is no
  // un-creating it. A back arrow here could only return to a key screen whose
  // own back leads forward again — a loop, not a step back.
  if (user && step === "profile") {
    return (
      <SignupShell
        step="profile"
        maxWidth="max-w-xl"
        onClose={onExit}
      >
        <ProfileStepBody onFinish={finishOnboarding} />
      </SignupShell>
    );
  }

  // ── Referral / join link: confirm before seeding the new account ────────
  // Reached only signed-out with a stashed `/join` link. Name the operator and
  // their relay(s) plainly, then hand off to the normal key-generation wizard;
  // relays are adopted at account creation, never here.
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

  // No step matches the current auth state — the wizard has nothing to show
  // (e.g. it was closed, or login landed while it sat on a signed-out step).
  // Hand back to the landing route, which re-decides where this user belongs.
  return null;
}

export default SignupWizard;
