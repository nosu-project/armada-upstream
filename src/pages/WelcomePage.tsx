import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { Navigate, useNavigate } from "react-router-dom";
import { Check, Copy, Eye, EyeOff } from "lucide-react";
import { generateSecretKey, getPublicKey, nip19 } from "nostr-tools";

import { ArmadaIdentity, ArmadaKey } from "@/components/brand/ArmadaCrest";
import { LandingPage } from "@/components/landing/LandingPage";
import LoginDialog from "@/components/auth/LoginDialog";
import { WizardShell } from "@/components/onboarding/WizardShell";
import { ProfileSettings } from "@/components/ProfileSettings";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { useAppContext } from "@/hooks/useAppContext";
import { useCurrentUser } from "@/hooks/useCurrentUser";
import { suppressNextSyncGate } from "@/hooks/useFreshLogin";
import { setOnboardingActive } from "@/hooks/useOnboarding";
import { useLoginActions } from "@/hooks/useLoginActions";
import { useMeshTransport } from "@/hooks/useMeshTransport";
import { useOnlineStatus } from "@/hooks/useOnlineStatus";
import { toast } from "@/hooks/useToast";
import { useNip29Servers } from "@/hooks/useNip29Servers";
import { writeClipboardText } from "@/lib/clipboard";
import { exportNsec, saveToKeyring } from "@/lib/credentialManager";
import { flattenLayout, mergeLayout, railKeyToRoute } from "@/lib/railLayout";

/**
 * First-run onboarding — the landing page and the full-page account wizard.
 *
 * A signed-OUT visitor sees the crest, wordmark and a single "Join" button
 * that opens the login dialog (the canonical logged-out CTA — same pattern as
 * JoinButton; never a raw Log in / Sign up pair); its "Create account" link
 * launches the account wizard. Account creation is a full-page step wizard in
 * the style of Ditto's onboarding (full-screen takeover, top progress bar,
 * one animated step at a time):
 *
 *   1. generate — a secret key is your identity; generate it.
 *   2. download — reveal the key and copy or back it up. Continue is gated on
 *      an explicit backup so a new user can't skip past saving their only
 *      login; then log in.
 *   3. profile  — the same WYSIWYG {@link ProfileSettings} editor used in
 *      Settings, so a new user sets their name/avatar before entering any
 *      community. Skippable.
 *
 * The wizard exits onto /discover: a new user browses live communities first
 * (and the Discover grid leads with a create-your-own tile), rather than
 * being pushed straight into founding a community of one.
 *
 * Nothing blocks a new user: every step past key-save is skippable. An
 * existing account logging in skips the wizard entirely — with a server they
 * are redirected onto it; with none they land in the normal app layout.
 */

const WIZARD_STEPS = ["generate", "download", "profile"] as const;
type WizardStep = (typeof WIZARD_STEPS)[number];

/** The shared wizard chrome, positioned within this wizard's step sequence. */
function SignupShell({ step, maxWidth, children }: {
  step: WizardStep;
  /** Column width cap (a `max-w-*` class). Text-heavy steps go a size up. */
  maxWidth?: "max-w-sm" | "max-w-md" | "max-w-xl";
  children: ReactNode;
}) {
  return (
    <WizardShell
      index={WIZARD_STEPS.indexOf(step)}
      total={WIZARD_STEPS.length}
      stepKey={step}
      maxWidth={maxWidth}
    >
      {children}
    </WizardShell>
  );
}

export function WelcomePage() {
  const { config } = useAppContext();
  const { user } = useCurrentUser();
  const { mesh } = useMeshTransport();
  const online = useOnlineStatus();
  const navigate = useNavigate();
  const login = useLoginActions();
  const [joinOpen, setJoinOpen] = useState(false);
  // The landing's scroll container. The ASCII sea reads its scrollTop inside
  // its own animation frame, so this is passed down rather than lifted into
  // state — scrolling the landing must not re-render this page.
  const landingScrollRef = useRef<HTMLElement>(null);
  // Wizard position. null = not in the wizard (landing when signed out; the
  // in-layout create/join step when signed in with no server).
  const [step, setStep] = useState<WizardStep | null>(null);
  const [nsec, setNsec] = useState("");
  const [showKey, setShowKey] = useState(false);
  const [copied, setCopied] = useState(false);
  // True while the OS keyring sheet is up (Continue is saving the key).
  const [saving, setSaving] = useState(false);

  // Whatever exit the wizard takes (finish, skip, or navigating onto a
  // community), it unmounts — so clear the onboarding flag here. Setting it is
  // done synchronously at login (see handleContinue) to beat the race.
  useEffect(() => () => setOnboardingActive(false), []);

  const handleGenerate = () => {
    setNsec(nip19.nsecEncode(generateSecretKey()));
    setShowKey(false);
    setCopied(false);
    setStep("download");
  };

  const copyKey = async () => {
    try {
      await writeClipboardText(nsec);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch {
      toast({
        title: "Copy failed",
        description: "Could not copy to the clipboard. Please select and copy it manually.",
        variant: "destructive",
      });
    }
  };

  // The wizard's exit: land the new user on Discover, where they can browse
  // live communities before committing to anything — the create-your-own tile
  // there is the first thing in the grid, so founding a community stays one
  // click away. Seeing the network beats being asked to build one from a
  // blank form (the classic dead-first-server trap).
  const finishOnboarding = () => {
    navigate("/discover");
  };

  // Continue IS the backup: save the key to the OS keyring / password manager
  // (a real, biometric-gated, recoverable backup), then log in and move to
  // profile setup. Onboarding must not advance without the key saved, so:
  //   - saved       → proceed.
  //   - cancelled   → the user dismissed the keyring sheet; stay put so their
  //                   only login isn't lost, and point them at Copy / retry.
  //   - unavailable → no keyring to save to (Firefox/Safari, or an Android with
  //                   no credential provider): export the key file instead (a
  //                   download on web, the share sheet on native), then proceed.
  const handleContinue = async () => {
    if (saving) return;
    let pubkey: string;
    let npub: string;
    try {
      const decoded = nip19.decode(nsec);
      if (decoded.type !== "nsec") throw new Error("Invalid nsec");
      pubkey = getPublicKey(decoded.data);
      npub = nip19.npubEncode(pubkey);
    } catch {
      toast({
        title: "Invalid key",
        description: "That key is invalid. Please generate a new one.",
        variant: "destructive",
      });
      return;
    }

    setSaving(true);
    try {
      const result = await saveToKeyring(npub, nsec);
      if (result === "cancelled") {
        toast({
          title: "Save your key first",
          description: "Save it to your password manager — or Copy it — before continuing. It's your only login.",
        });
        return;
      }
      if (result === "unavailable") {
        // No keyring here — save the key to the filesystem so it isn't lost.
        const location = await exportNsec(nsec);
        if (!location) {
          toast({
            title: "Couldn't save your key",
            description: "Saving to the filesystem failed. Copy your key and store it safely, then continue.",
            variant: "destructive",
          });
          return;
        }
        toast({
          title: "Key saved",
          description: `Saved to ${location}. Keep it somewhere safe — it's your only login.`,
        });
      }
      // Brand-new account: nothing to catch up on, so skip the post-login sync
      // gate. Otherwise its full-screen overlay paints over the profile/add
      // wizard steps (SyncGate is z-100, the wizard z-50) while a network-bound
      // sync runs — on a slow phone that looks like onboarding was skipped.
      suppressNextSyncGate(pubkey);
      // Mark onboarding in progress BEFORE login so it's already true on the
      // commit that first exposes the user — otherwise the headless web-push
      // opt-in (and the native notification step) would enqueue and paint over
      // the profile step. Cleared when this wizard unmounts.
      setOnboardingActive(true);
      login.nsec(nsec);
      setStep("profile");
    } finally {
      setSaving(false);
    }
  };

  // A signed-in user with a community never sees onboarding: redirect onto
  // the FIRST item of their arranged community rail — NIP-29 servers AND
  // Concord V1/V2 communities intermixed in the order they chose (the same
  // list the far-left rail renders). The persisted `railLayout` (seeded from
  // the legacy flat `railOrder`) lives in app config and is available
  // synchronously, so the redirect commits without racing the rail's async
  // load. `mergeLayout` seeds the working order from `railOrder` and appends
  // any live NIP-29 server the layout doesn't yet know about.
  const liveServers = useNip29Servers();
  const firstRoute = useMemo(() => {
    const servers = new Set(liveServers);
    const ordered = flattenLayout(
      mergeLayout(config.railLayout, config.railOrder, liveServers),
    );
    for (const key of ordered) {
      if (!key.startsWith("c1:") && !key.startsWith("c2:") && !servers.has(key)) continue;
      const route = railKeyToRoute(key);
      if (route) return route;
    }
    return null;
  }, [config.railLayout, config.railOrder, liveServers]);
  if (user && !online && mesh.available) {
    return <Navigate to="/mesh" replace />;
  }
  if (user && firstRoute) {
    return <Navigate to={firstRoute} replace />;
  }
  // Signed in and NOT mid-signup: this page is only the onboarding surface
  // during the active account-creation wizard (`step` walks generate →
  // download → profile). A signed-in user who lands here any other way — a
  // relaunch, a manual /welcome, a redirect — is not creating an account, so
  // send them to DMs rather than re-forcing getting-started. Onboarding only
  // happens on account creation.
  if (user && step === null) {
    return <Navigate to="/dms" replace />;
  }

  // ── Wizard step 1: generate the key ─────────────────────────────────────
  if (!user && step === "generate") {
    return (
      <SignupShell step="generate">
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
          <button
            type="button"
            onClick={() => setStep(null)}
            className="text-sm text-muted-foreground transition-colors hover:text-foreground"
          >
            Back
          </button>
        </div>
      </SignupShell>
    );
  }

  // ── Wizard step 2: save the key ─────────────────────────────────────────
  if (!user && step === "download") {
    return (
      <SignupShell step="download">
        <div className="flex flex-col items-center gap-8 text-center">
          <ArmadaKey size={110} />
          <div className="space-y-2.5">
            <h1 className="font-mono text-2xl font-bold lowercase tracking-tight text-foreground">
              save your secret key
            </h1>
            <p className="text-sm leading-relaxed text-muted-foreground">
              This key is your one and only login. Save it somewhere safe
              before continuing.
            </p>
          </div>

          <div className="relative w-full">
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
              onClick={() => setShowKey((v) => !v)}
            >
              {showKey ? (
                <EyeOff className="size-4 text-muted-foreground" />
              ) : (
                <Eye className="size-4 text-muted-foreground" />
              )}
            </Button>
          </div>

          <div className="w-full space-y-3">
            <Button
              size="lg"
              className="h-12 w-full clip-corner-lg text-base font-medium"
              onClick={handleContinue}
              disabled={saving}
            >
              {saving ? "Saving…" : "Save key & continue"}
            </Button>
            <Button
              variant="ghost"
              className="w-full text-muted-foreground"
              onClick={copyKey}
              disabled={saving}
            >
              {copied ? (
                <Check className="size-4 text-success" />
              ) : (
                <Copy className="size-4" />
              )}
              {copied ? "Copied" : "Copy key"}
            </Button>
          </div>

          <div className="w-full clip-corner-lg bg-amber-500/10 p-3 text-left">
            <p className="mb-1 text-xs font-semibold text-amber-600 dark:text-amber-300">
              Important Warning
            </p>
            <p className="text-xs text-amber-700 dark:text-amber-300/90">
              This key is your primary and only means of accessing your
              account. Store it safely and securely.
            </p>
          </div>
        </div>
      </SignupShell>
    );
  }

  // ── Wizard step 3: profile setup ────────────────────────────────────────
  if (user && step === "profile") {
    return (
      <SignupShell step="profile" maxWidth="max-w-xl">
        <div className="space-y-1.5 text-center">
          <ArmadaIdentity size={84} className="mx-auto mb-4" />
          <h1 className="font-mono text-2xl font-bold lowercase tracking-tight text-foreground">
            set up your profile
          </h1>
          <p className="text-sm text-muted-foreground">
            How people see you. You can change it anytime.
          </p>
        </div>

        <ProfileSettings saveLabel="Continue" centerSave showNip05={false} onSaved={finishOnboarding} />

        <Button
          variant="ghost"
          className="mx-auto text-muted-foreground"
          onClick={finishOnboarding}
        >
          Skip for now
        </Button>
      </SignupShell>
    );
  }

  // ── Signed-out landing ──────────────────────────────────────────────────
  // The marketing surface lives in {@link LandingPage}: a scrolling deck over
  // the ASCII sea. `<main>` is the scroll container, and the sea reads its
  // scrollTop directly, so the ref has to be handed down.
  return (
    <main ref={landingScrollRef} className="relative flex-1 min-w-0 overflow-y-auto">
      <LandingPage onJoin={() => setJoinOpen(true)} scrollRef={landingScrollRef} />

      <LoginDialog
        isOpen={joinOpen}
        onClose={() => setJoinOpen(false)}
        onLogin={() => setJoinOpen(false)}
        onSignupClick={() => {
          setJoinOpen(false);
          setStep("generate");
        }}
      />
    </main>
  );
}
