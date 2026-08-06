import { useNostrLogin } from "@nostrify/react/login";
import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { Navigate, useNavigate } from "react-router-dom";
import { AlertTriangle, Check, Copy, Download, Eye, EyeOff } from "lucide-react";
import { generateSecretKey, getPublicKey, nip19 } from "nostr-tools";

import { ArmadaIdentity, ArmadaKey } from "@/components/brand/ArmadaCrest";
import { LandingPage } from "@/components/landing/LandingPage";
import LoginScreen from "@/components/auth/LoginScreen";
import { WizardShell } from "@/components/onboarding/WizardShell";
import { ProfileSettings } from "@/components/ProfileSettings";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { useAppContext } from "@/hooks/useAppContext";
import { useCurrentUser } from "@/hooks/useCurrentUser";
import { suppressNextSyncGate } from "@/hooks/useFreshLogin";
import { setOnboardingActive } from "@/hooks/useOnboarding";
import { clearPendingJoin, peekPendingJoin, type JoinLink } from "@/lib/joinLink";
import { uniqueRelayUrls } from "@/lib/nip65";
import { markRelayRecoveryPromptShown } from "@/lib/relayRecoveryPrompt";
import { useLoginActions } from "@/hooks/useLoginActions";
import { useMeshTransport } from "@/hooks/useMeshTransport";
import { useOnlineStatus } from "@/hooks/useOnlineStatus";
import { toast } from "@/hooks/useToast";
import { useNip29Servers } from "@/hooks/useNip29Servers";
import { writeClipboardText } from "@/lib/clipboard";
import { backUpNsec } from "@/lib/credentialManager";
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
 *      an explicit backup — a successful Copy, keyring save, or file export —
 *      so a new user can't skip past saving their only login; then log in.
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

export function WelcomePage() {
  const { config, updateConfig } = useAppContext();
  const { user } = useCurrentUser();
  const { logins } = useNostrLogin();
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
  // A pending referral/join link (a `/join` deep link stashed it before routing
  // here): the operator's relay set to seed this new account onto. Read once on
  // mount; `joinAccepted` gates the confirmation screen ahead of the wizard.
  const [join, setJoin] = useState<JoinLink | undefined>(() => peekPendingJoin());
  const [joinAccepted, setJoinAccepted] = useState(false);
  const dismissJoin = () => {
    clearPendingJoin();
    setJoin(undefined);
  };
  const [nsec, setNsec] = useState("");
  const [showKey, setShowKey] = useState(false);
  const [copied, setCopied] = useState(false);
  // True while the OS keyring sheet is up (Save key is running).
  const [saving, setSaving] = useState(false);
  // The gate on the save step: Continue stays disabled until the key has
  // demonstrably left this screen — copied to the clipboard, stored in the OS
  // keyring, or written to a file. A dismissed keyring sheet is not a backup.
  const [backedUp, setBackedUp] = useState(false);

  // Whatever exit the wizard takes (finish, skip, or navigating onto a
  // community), it unmounts — so clear the onboarding flag here. Setting it is
  // done synchronously at login (see handleContinue) to beat the race.
  useEffect(() => () => setOnboardingActive(false), []);

  const handleGenerate = () => {
    setNsec(nip19.nsecEncode(generateSecretKey()));
    setShowKey(false);
    setCopied(false);
    setBackedUp(false);
    setStep("download");
  };

  /** The generated key's identity, or null while there's no valid key in hand. */
  const identity = useMemo(() => {
    if (!nsec) return null;
    try {
      const decoded = nip19.decode(nsec);
      if (decoded.type !== "nsec") return null;
      const pubkey = getPublicKey(decoded.data);
      return { pubkey, npub: nip19.npubEncode(pubkey) };
    } catch {
      return null;
    }
  }, [nsec]);

  const copyKey = async () => {
    try {
      await writeClipboardText(nsec);
      setCopied(true);
      setBackedUp(true);
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

  // Back the key up to a place the user chose and watched it go to — a "Save
  // as…" dialog on web, the Credential Manager sheet on native. Doesn't
  // advance: Continue is gated on this (or Copy) having actually succeeded, so
  // the outcomes stay apart rather than collapsing into "the button ran". A
  // dismissed dialog leaves the gate shut.
  const saveKey = async () => {
    if (saving) return;
    if (!identity) {
      toast({
        title: "Invalid key",
        description: "That key is invalid. Please generate a new one.",
        variant: "destructive",
      });
      return;
    }

    setSaving(true);
    try {
      const result = await backUpNsec(identity.npub, nsec);
      if (result.status === "cancelled") {
        toast({
          title: "Key not saved",
          description: "Save the file — or Copy the key — before continuing. It's your only login.",
        });
        return;
      }
      if (result.status === "failed") {
        toast({
          title: "Couldn't save your key",
          description: "Saving failed. Copy your key and store it somewhere safe, then continue.",
          variant: "destructive",
        });
        return;
      }
      setBackedUp(true);
      toast({
        title: "Key saved",
        description: `Saved to ${result.location}. Keep it — it's your only login.`,
      });
    } finally {
      setSaving(false);
    }
  };

  // Leave the save step: log in as the new account and move to profile setup.
  // Only reachable once `backedUp` is set.
  const handleContinue = () => {
    // Brand-new account: nothing to catch up on, so skip the post-login sync
    // gate. Otherwise its full-screen overlay paints over the profile/add
    // wizard steps (SyncGate is z-100, the wizard z-50) while a network-bound
    // sync runs — on a slow phone that looks like onboarding was skipped.
    if (identity) {
      suppressNextSyncGate(identity.pubkey);
      // A brand-new account has nothing on any relay to recover, so never show
      // it the "restore your setup" prompt. Portability comes from its first
      // publish, or Settings on demand.
      markRelayRecoveryPromptShown(identity.pubkey);
    }
    // A referral/join link: make this new account live on the operator's
    // relay(s). This is a LOCAL config seed only — no list is published (that
    // stays an explicit action). On a first/only account, adopt their set as
    // the app relays; with other accounts already on the device, only ADD
    // them, so an existing account's relays are never rewritten.
    if (join) {
      const relays = uniqueRelayUrls(join.relays);
      updateConfig((current) => ({
        ...current,
        appRelays: logins.length === 0
          ? relays
          : uniqueRelayUrls([...current.appRelays, ...relays]),
      }));
      clearPendingJoin();
    }
    // Mark onboarding in progress BEFORE login so it's already true on the
    // commit that first exposes the user — otherwise the headless web-push
    // opt-in (and the native notification step) would enqueue and paint over
    // the profile step. Cleared when this wizard unmounts.
    setOnboardingActive(true);
    login.nsec(nsec);
    setStep("profile");
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
    return <Navigate to="/dm" replace />;
  }

  // ── Wizard step 1: generate the key ─────────────────────────────────────
  if (!user && step === "generate") {
    return (
      <SignupShell step="generate" onBack={() => setStep(null)} onClose={() => setStep(null)}>
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
      </SignupShell>
    );
  }

  // ── Wizard step 2: save the key ─────────────────────────────────────────
  if (!user && step === "download") {
    return (
      <SignupShell
        step="download"
        onBack={() => setStep("generate")}
        onClose={() => setStep(null)}
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
              type={showKey ? "text" : "password"}
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
                {saving ? "Saving…" : "Save key"}
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
                {copied ? "Copied" : "Copy key"}
              </Button>
            </div>
            <Button
              size="lg"
              className="h-12 w-full clip-corner-lg text-base font-medium"
              onClick={handleContinue}
              disabled={!backedUp || saving}
            >
              Continue
            </Button>
          </div>
        </div>
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
        onClose={() => setStep(null)}
      >
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
      </SignupShell>
    );
  }

  // ── Referral / join link: confirm before seeding the new account ────────
  // Reached only signed-out with a stashed `/join` link. Name the operator and
  // their relay(s) plainly, then hand off to the normal key-generation wizard;
  // relays are adopted at account creation, never here.
  if (!user && join && !joinAccepted && step === null) {
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
              onClick={() => {
                setJoinAccepted(true);
                setStep("generate");
              }}
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

  // ── Signed-out landing ──────────────────────────────────────────────────
  // The marketing surface lives in {@link LandingPage}: a scrolling deck over
  // the ASCII sea. `<main>` is the scroll container, and the sea reads its
  // scrollTop directly, so the ref has to be handed down.
  return (
    <main ref={landingScrollRef} className="relative flex-1 min-w-0 overflow-y-auto">
      <LandingPage onJoin={() => setJoinOpen(true)} scrollRef={landingScrollRef} />

      <LoginScreen
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
