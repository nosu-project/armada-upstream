import { useMemo, useState, type ReactNode } from "react";
import { Link, Navigate, useNavigate } from "react-router-dom";
import { Eye, EyeOff } from "lucide-react";
import { generateSecretKey, getPublicKey, nip19 } from "nostr-tools";

import { ArmadaCrest, ArmadaCrestKeyframes, ArmadaIdentity, ArmadaKey } from "@/components/brand/ArmadaCrest";
import { BrandMark } from "@/components/brand/BrandMark";
import LoginDialog from "@/components/auth/LoginDialog";
import { AddBody } from "@/components/dialogs/AddDialog";
import { ProfileSettings } from "@/components/ProfileSettings";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { useAppContext } from "@/hooks/useAppContext";
import { useCurrentUser } from "@/hooks/useCurrentUser";
import { suppressNextSyncGate } from "@/hooks/useFreshLogin";
import { useLoginActions } from "@/hooks/useLoginActions";
import { useMeshTransport } from "@/hooks/useMeshTransport";
import { useOnlineStatus } from "@/hooks/useOnlineStatus";
import { toast } from "@/hooks/useToast";
import { useUserGroupList } from "@/hooks/useUserGroupList";
import { saveNsec } from "@/lib/credentialManager";
import { normalizeRelayUrl, PINNED_RAIL_RELAYS } from "@/lib/platform";
import { flattenLayout, mergeLayout, railKeyToRoute } from "@/lib/railLayout";
import { cn } from "@/lib/utils";

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
 *   2. download — reveal/save the key (credential manager or file), log in.
 *   3. profile  — the same WYSIWYG {@link ProfileSettings} editor used in
 *      Settings, so a new user sets their name/avatar before entering any
 *      community. Skippable.
 *   4. add      — the Add wizard body ({@link AddBody}) inline: start an
 *      encrypted community, or paste an invite link / server URL. Skippable
 *      straight to DMs.
 *
 * Nothing blocks a new user: every step past key-save is skippable. An
 * existing account logging in skips the wizard entirely — with a server they
 * are redirected onto it; with none they get the create/join step in the
 * normal app layout.
 */

const WIZARD_STEPS = ["generate", "download", "profile", "add"] as const;
type WizardStep = (typeof WIZARD_STEPS)[number];

/**
 * Full-screen wizard chrome: background takeover, thin progress bar on top,
 * and a centered, width-capped column that fades/slides in per step.
 */
function WizardShell({ step, maxWidth = "max-w-sm", children }: {
  step: WizardStep;
  /** Column width cap (a `max-w-*` class). Text-heavy steps go a size up. */
  maxWidth?: "max-w-sm" | "max-w-md" | "max-w-xl";
  children: ReactNode;
}) {
  const pct = ((WIZARD_STEPS.indexOf(step) + 1) / WIZARD_STEPS.length) * 100;
  return (
    <div className="fixed inset-0 z-50 flex flex-col bg-background">
      <div className="h-1 shrink-0 bg-muted">
        <div
          className="h-full bg-primary transition-all duration-500 ease-out"
          style={{ width: `${pct}%` }}
        />
      </div>
      <div className="flex-1 overflow-y-auto">
        <div
          key={step}
          className={cn(
            "mx-auto flex min-h-full w-full flex-col justify-center gap-8 px-6 py-12 safe-area-top safe-area-bottom",
            "animate-in fade-in slide-in-from-right-4 duration-300",
            maxWidth,
          )}
        >
          {children}
        </div>
      </div>
      <ArmadaCrestKeyframes />
    </div>
  );
}

export function WelcomePage() {
  const { config } = useAppContext();
  const { user } = useCurrentUser();
  const { mesh } = useMeshTransport();
  const online = useOnlineStatus();
  const navigate = useNavigate();
  const login = useLoginActions();
  const { data: groupList } = useUserGroupList();
  const [joinOpen, setJoinOpen] = useState(false);
  // Wizard position. null = not in the wizard (landing when signed out; the
  // in-layout create/join step when signed in with no server).
  const [step, setStep] = useState<WizardStep | null>(null);
  const [nsec, setNsec] = useState("");
  const [showKey, setShowKey] = useState(false);

  const handleGenerate = () => {
    setNsec(nip19.nsecEncode(generateSecretKey()));
    setShowKey(false);
    setStep("download");
  };

  // "Skip for now": leave the create/join step for DMs. Nothing to persist —
  // the create/join takeover only ever shows mid-signup (the wizard drives it
  // in-session), never on a later relaunch (see the guard below and
  // HomeRedirect), so there's no relaunch nag to suppress.
  const skipOnboarding = () => {
    navigate("/dms");
  };

  // Save the key via the best available method (credential manager on
  // Chromium, file download elsewhere), then log in and move to profile setup.
  const handleSaveKey = async () => {
    try {
      const decoded = nip19.decode(nsec);
      if (decoded.type !== "nsec") throw new Error("Invalid nsec");
      const pubkey = getPublicKey(decoded.data);
      await saveNsec(nip19.npubEncode(pubkey), nsec);
      // Brand-new account: nothing to catch up on, so skip the post-login sync
      // gate. Otherwise its full-screen overlay paints over the profile/add
      // wizard steps (SyncGate is z-100, the wizard z-50) while a network-bound
      // sync runs — on a slow phone that looks like onboarding was skipped.
      suppressNextSyncGate(pubkey);
      login.nsec(nsec);
      setStep("profile");
    } catch {
      toast({
        title: "Save failed",
        description: "Could not save the key. Please copy it manually.",
        variant: "destructive",
      });
    }
  };

  // A signed-in user with a community never sees onboarding: redirect onto
  // the FIRST item of their arranged community rail — NIP-29 servers AND
  // Concord V1/V2 communities intermixed in the order they chose (the same
  // list the far-left rail renders). `addedRelays` alone is NIP-29-only, so a
  // user whose first rail item is a Concord community would otherwise be
  // bounced into a NIP-29 server. The persisted `railLayout` (seeded from the
  // legacy flat `railOrder`) lives in app config and is available
  // synchronously, so the redirect commits without racing the rail's async
  // load. `mergeLayout` seeds the working order from `railOrder` and appends
  // any live NIP-29 server the layout doesn't yet know about.
  const liveServers = useMemo(
    () =>
      [...PINNED_RAIL_RELAYS, ...config.addedRelays]
        .map((u) => normalizeRelayUrl(u))
        .filter((u): u is string => Boolean(u)),
    [config.addedRelays],
  );
  const firstRoute = useMemo(() => {
    const servers = new Set(liveServers);
    const groupServers = groupList?.servers ?? [];
    const ordered = flattenLayout(
      mergeLayout(config.railLayout, config.railOrder, liveServers),
    );
    for (const key of ordered) {
      if (!key.startsWith("c1:") && !key.startsWith("c2:")) {
        const live =
          servers.has(key) ||
          groupServers.some((s) => normalizeRelayUrl(s) === key);
        if (!live) continue;
      }
      const route = railKeyToRoute(key);
      if (route) return route;
    }
    return null;
  }, [config.railLayout, config.railOrder, liveServers, groupList?.servers]);
  if (user && !online && mesh.available) {
    return <Navigate to="/mesh" replace />;
  }
  if (user && firstRoute) {
    return <Navigate to={firstRoute} replace />;
  }
  // Signed in, no community, and NOT mid-signup: don't show the create/join
  // takeover. This page is only the onboarding surface during the active
  // account-creation wizard (`step` walks generate → download → profile →
  // add). A signed-in, community-less user who lands here any other way — a
  // relaunch, a manual /welcome, a redirect — is not creating an account, so
  // send them to DMs rather than re-forcing getting-started. Onboarding only
  // happens on account creation.
  if (user && step === null) {
    return <Navigate to="/dms" replace />;
  }

  // ── Wizard step 1: generate the key ─────────────────────────────────────
  if (!user && step === "generate") {
    return (
      <WizardShell step="generate">
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
      </WizardShell>
    );
  }

  // ── Wizard step 2: save the key ─────────────────────────────────────────
  if (!user && step === "download") {
    return (
      <WizardShell step="download">
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

          <Button
            size="lg"
            className="h-12 w-full clip-corner-lg text-base font-medium"
            onClick={handleSaveKey}
          >
            Continue
          </Button>

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
      </WizardShell>
    );
  }

  // ── Wizard step 3: profile setup ────────────────────────────────────────
  if (user && step === "profile") {
    return (
      <WizardShell step="profile" maxWidth="max-w-xl">
        <div className="space-y-1.5 text-center">
          <ArmadaIdentity size={84} className="mx-auto mb-4" />
          <h1 className="font-mono text-2xl font-bold lowercase tracking-tight text-foreground">
            set up your profile
          </h1>
          <p className="text-sm text-muted-foreground">
            How people see you. You can change it anytime.
          </p>
        </div>

        <ProfileSettings saveLabel="Continue" centerSave onSaved={() => setStep("add")} />

        <Button
          variant="ghost"
          className="mx-auto text-muted-foreground"
          onClick={() => setStep("add")}
        >
          Skip for now
        </Button>
      </WizardShell>
    );
  }

  // ── Wizard step 4: create/join ──────────────────────────────────────────
  if (user && step === "add") {
    return (
      <WizardShell step="add" maxWidth="max-w-md">
        {/* Inline Add wizard: create an encrypted community, or paste an
            invite link / server URL. On success it navigates itself (or the
            added server triggers the redirect above). */}
        <AddBody onDone={() => undefined} />

        <Button
          variant="ghost"
          className="mx-auto text-muted-foreground"
          onClick={skipOnboarding}
        >
          Skip for now
        </Button>
      </WizardShell>
    );
  }

  // ── Signed-out landing ──────────────────────────────────────────────────
  return (
    <main className="flex-1 min-w-0 overflow-y-auto">
      <div className="mx-auto flex min-h-full max-w-xl flex-col items-center justify-center gap-12 px-6 py-16 safe-area-top safe-area-bottom">
        <div className="flex flex-col items-center gap-8">
          <ArmadaCrest size={150} />
          <BrandMark />
        </div>

        <div className="w-full max-w-sm">
          <Button
            size="lg"
            onClick={() => setJoinOpen(true)}
            className="h-12 w-full clip-corner-lg text-base font-medium"
          >
            Join
          </Button>
          <Link
            to="/about"
            className="mt-4 block text-center text-sm text-muted-foreground transition-colors hover:text-foreground"
          >
            How does Armada work?
          </Link>
        </div>

        <LoginDialog
          isOpen={joinOpen}
          onClose={() => setJoinOpen(false)}
          onLogin={() => setJoinOpen(false)}
          onSignupClick={() => {
            setJoinOpen(false);
            setStep("generate");
          }}
        />
      </div>

      <ArmadaCrestKeyframes />
    </main>
  );
}
