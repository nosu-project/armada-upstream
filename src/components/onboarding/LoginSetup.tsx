import { Capacitor } from "@capacitor/core";
import { BatteryCharging, Bell, Lock, Waypoints } from "lucide-react";
import { useCallback, useEffect, useState, type ReactNode } from "react";

import { WizardShell, WizardStepBody } from "@/components/onboarding/WizardShell";
import { useSyncGateActive } from "@/components/SyncGate";
import { Button } from "@/components/ui/button";
import { RelayBootstrapForm } from "@/components/RelayBootstrapForm";
import { useAppContext } from "@/hooks/useAppContext";
import { useCurrentUser } from "@/hooks/useCurrentUser";
import { useEncryptedSettings } from "@/hooks/useEncryptedSettings";
import { useNip29Servers } from "@/hooks/useNip29Servers";
import { useOnboardingActive } from "@/hooks/useOnboarding";
import {
  markRelayRecoveryPromptShown,
  relayRecoveryPromptShown,
} from "@/lib/relayRecoveryPrompt";
import {
  enableNativeNotifications,
  nativeNotificationIntent,
} from "@/hooks/useNativeNotifications";
import { hasNativeNotificationService } from "@/lib/platform";
import {
  registerConsentPromptOpener,
  resolveConsentPrompt,
  setDecryptConsent,
} from "@/lib/decryptConsent";
import {
  ArmadaNotification,
  isIgnoringBatteryOptimizations,
  requestIgnoreBatteryOptimizations,
} from "@/lib/nativeNotifications";
import {
  markWebPushPromptShown,
  registerWebPushOptInOpener,
  runWebPushEnable,
  webPushOptInMode,
} from "@/lib/webPushPrompt";

/**
 * The post-login setup flow.
 *
 * Everything a user has to answer after signing in — the OS notification
 * permission, the Android battery-optimization exemption, and the bulk-decrypt
 * consent — used to arrive as three unrelated interruptions: two of them raw
 * system dialogs fired from headless mounts with no explanation, one a toast,
 * one a modal, all racing each other and the sync overlay. This replaces them
 * with one queue of full-screen steps in the signup wizard's chrome: a progress
 * bar, one question at a time, each with the context needed to answer it, and
 * each skippable.
 *
 * Steps are enqueued only when they actually apply, so a web user with a local
 * key sees nothing at all. The flow holds off entirely while the sync gate is
 * up, then presents whatever is queued.
 */

/** Steps, in the order they're offered. */
type StepId = "relays" | "notifications" | "webpush" | "battery" | "decrypt";

/**
 * Set once the notification step has been shown. Unlike the old launch-time OS
 * prompt (which re-fired every launch until the user answered at OS level), a
 * declined full-screen step is not re-asked — the Settings toggle is the way
 * back in.
 */
const NOTIF_PROMPT_KEY = "armada:notif-prompt-shown";



/**
 * Set once the battery-exemption step has been shown. Keep the original key so
 * timestamps written by older releases also count as "already offered". A
 * user who keeps Android's optimized setting has made a valid choice; the
 * persistent warning in notification Settings remains the non-modal way back.
 */
const BATTERY_PROMPT_KEY = "armada:battery-exemption-nudged-at";

function read(key: string): string | null {
  try {
    return localStorage.getItem(key);
  } catch {
    return null;
  }
}

function write(key: string, value: string): void {
  try {
    localStorage.setItem(key, value);
  } catch {
    // best-effort
  }
}

/** Whether the Android battery-optimization step should be offered right now. */
async function batteryStepApplies(): Promise<boolean> {
  if (Capacitor.getPlatform() !== "android") return false;
  if (read(BATTERY_PROMPT_KEY)) return false;
  return !(await isIgnoringBatteryOptimizations());
}

export function LoginSetup() {
  const { user } = useCurrentUser();
  const { config } = useAppContext();
  const syncing = useSyncGateActive();
  // Signup logs the user in before the profile/create-join steps render (and
  // suppresses the sync gate), so hold every step until the wizard is done —
  // otherwise a queued step paints over profile creation at z-[260].
  const onboarding = useOnboardingActive();

  const [queue, setQueue] = useState<StepId[]>([]);
  const [completed, setCompleted] = useState(0);
  const ownsRelayList = user
    ? !config.relayMetadata.pubkey || config.relayMetadata.pubkey === user.pubkey
    : false;
  const hasSignedRelayList = ownsRelayList && config.relayMetadata.relays.length > 0;

  // The recovery prompt is only meaningful when sync came back empty-handed.
  // If the account already has a relay list, restored encrypted settings, or
  // any joined server, there is nothing to recover — don't interrupt.
  const { doc: settings, isFetched: settingsFetched } = useEncryptedSettings();
  const joinedServers = useNip29Servers();
  const hasRestoredData =
    hasSignedRelayList || settings !== null || joinedServers.length > 0;

  const enqueue = useCallback((id: StepId) => {
    setQueue((q) => (q.includes(id) ? q : [...q, id]));
  }, []);

  const advance = useCallback(() => {
    setQueue((q) => q.slice(1));
    setCompleted((c) => c + 1);
  }, []);

  // The decrypt step is demand-driven: the consent gate opens it the first time
  // a surface needs a real (uncached) decrypt, which for most users is landing
  // on /dm right after login — but it can also be much later, long after the
  // other steps are done. Either way it joins the same queue.
  useEffect(() => registerConsentPromptOpener(() => enqueue("decrypt")), [enqueue]);

  // The web-push opt-in is driven by the app-wide push bridge
  // (WebPushNotifications), which knows when a fresh user could receive push.
  // It asks us to surface the step here — parallel to the native
  // `NotificationsStep`, but for web/PWA.
  useEffect(() => registerWebPushOptInOpener(() => enqueue("webpush")), [enqueue]);

  // Login discovery adopts a signed relay list before the sync gate lifts, and
  // the account wizard opts brand-new accounts out entirely. What's left for
  // this step is the genuine recovery case: an existing account whose setup
  // sync couldn't find. Offer a plain, skippable lookup; the same form lives in
  // Settings for later. A skip is remembered per account.
  useEffect(() => {
    if (!user || syncing || onboarding) return;
    // Restore can settle across adjacent renders. If any data arrives after the
    // prompt was queued from an empty render, pull it rather than leaving a
    // stale "couldn't find your setup" screen over a working account.
    if (hasRestoredData) {
      setQueue((current) => current.filter((candidate) => candidate !== "relays"));
      return;
    }
    // An in-flight settings read looks empty; wait for it to resolve so a slow
    // relay is never mistaken for "nothing found".
    if (!settingsFetched) return;
    if (relayRecoveryPromptShown(user.pubkey)) return;
    enqueue("relays");
  }, [user, syncing, onboarding, hasRestoredData, settingsFetched, enqueue]);

  // If this unmounts with a decrypt prompt still queued, the callers awaiting
  // that decision would hang forever. Release them as "not now" (unpersisted,
  // so they're asked again next time).
  useEffect(() => {
    return () => resolveConsentPrompt("declined");
  }, []);

  // Probe the native permission steps once the user is in and the sync overlay
  // is gone.
  useEffect(() => {
    if (!user || syncing || onboarding) return;
    if (!hasNativeNotificationService()) return;
    let cancelled = false;
    (async () => {
      try {
        const { granted } = await ArmadaNotification.checkPermission();
        if (cancelled) return;
        if (!granted) {
          if (nativeNotificationIntent() && !read(NOTIF_PROMPT_KEY)) enqueue("notifications");
          return;
        }
        // Already granted — the exemption is the only thing that may be missing.
        if (await batteryStepApplies()) {
          if (!cancelled) enqueue("battery");
        }
      } catch {
        // Permission probe failed — offer nothing rather than guess.
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [user, syncing, onboarding, enqueue]);

  const step = queue[0];

  // Record that a step was surfaced as it renders, so a user who force-quits
  // mid-flow isn't asked the same thing on every launch.
  useEffect(() => {
    if (step === "relays" && user?.pubkey) markRelayRecoveryPromptShown(user.pubkey);
    if (step === "notifications") write(NOTIF_PROMPT_KEY, "1");
    if (step === "webpush") markWebPushPromptShown();
    if (step === "battery") write(BATTERY_PROMPT_KEY, "1");
  }, [step, user?.pubkey]);

  // Do not paint one contradictory frame while the effect above removes a
  // relay step that was queued just before restore data arrived.
  if (!step || syncing || onboarding || (step === "relays" && hasRestoredData)) return null;

  const total = completed + queue.length;

  return (
    <WizardShell index={completed} total={total} stepKey={step} zClassName="z-[260]">
      {step === "notifications" && (
        <NotificationsStep
          onDone={async (granted) => {
            // Granting is what makes the exemption matter, so chain straight
            // into it rather than waiting for the next launch to notice.
            if (granted && (await batteryStepApplies())) enqueue("battery");
            advance();
          }}
        />
      )}
      {step === "relays" && <RelayStep onDone={advance} />}
      {step === "webpush" && <WebPushStep onDone={advance} />}
      {step === "battery" && <BatteryStep onDone={advance} />}
      {step === "decrypt" && <DecryptStep onDone={advance} />}
    </WizardShell>
  );
}

function RelayStep({ onDone }: { onDone: () => void }) {
  return (
    <WizardStepBody
      glyph={
        <StepGlyph>
          <Waypoints className="size-9" />
        </StepGlyph>
      }
      title="restore your setup"
      description="We couldn't automatically find your servers and settings for this account. If you know a server address you've used before, enter it to look them up, or skip this and keep going."
    >
      <RelayBootstrapForm onDone={onDone} onSkip={onDone} />
    </WizardStepBody>
  );
}

/** Circular glyph frame matching the signup wizard's brand marks. */
function StepGlyph({ children }: { children: ReactNode }) {
  return (
    <div className="flex size-20 items-center justify-center clip-corner-lg bg-primary/15 text-primary">
      {children}
    </div>
  );
}

function NotificationsStep({ onDone }: { onDone: (granted: boolean) => void }) {
  const [busy, setBusy] = useState(false);

  const enable = async () => {
    setBusy(true);
    try {
      onDone(await enableNativeNotifications());
    } catch {
      onDone(false);
    } finally {
      setBusy(false);
    }
  };

  return (
    <WizardStepBody
      glyph={
        <StepGlyph>
          <Bell className="size-9" />
        </StepGlyph>
      }
      title="stay in the loop"
      description="Armada can notify you about direct messages, mentions and replies while the app is closed. Nothing leaves your device to a push service; your phone holds the connection itself."
    >
      <div className="w-full space-y-3">
        <Button
          size="lg"
          className="h-12 w-full clip-corner-lg text-base font-medium"
          onClick={enable}
          disabled={busy}
        >
          Enable notifications
        </Button>
        <Button
          variant="ghost"
          className="w-full text-muted-foreground"
          onClick={() => onDone(false)}
          disabled={busy}
        >
          Not now
        </Button>
      </div>
    </WizardStepBody>
  );
}

/**
 * The web/PWA counterpart to `NotificationsStep`. Unlike the native path, this
 * uses Web Push (a push service is involved), so the copy stays honest about
 * that rather than claiming nothing leaves the device.
 */
function WebPushStep({ onDone }: { onDone: () => void }) {
  const [busy, setBusy] = useState(false);
  // Where Web Push is unavailable this same step offers the in-page notifier
  // instead, so the copy must not promise closed-app delivery.
  const foreground = webPushOptInMode() === "foreground";

  const enable = async () => {
    setBusy(true);
    try {
      // Runs the live hook's enable() — this click is the gesture that grants
      // Notification permission.
      await runWebPushEnable();
    } catch {
      // Permission denied or subscribe failed — the Settings toggle remains.
    } finally {
      setBusy(false);
      onDone();
    }
  };

  return (
    <WizardStepBody
      glyph={
        <StepGlyph>
          <Bell className="size-9" />
        </StepGlyph>
      }
      title="stay in the loop"
      description={foreground
        ? "Armada can notify you about direct messages, mentions and replies while it's open — including when it's behind another window. This browser can't deliver notifications once Armada is closed, so nothing leaves your device for them."
        : "Armada can notify you about direct messages, mentions and replies even while it's closed. Delivery goes through your browser's push service; the notification carries no message content — Armada fetches and decrypts it on your device."}
    >
      <div className="w-full space-y-3">
        <Button
          size="lg"
          className="h-12 w-full clip-corner-lg text-base font-medium"
          onClick={enable}
          disabled={busy}
        >
          Enable notifications
        </Button>
        <Button
          variant="ghost"
          className="w-full text-muted-foreground"
          onClick={() => onDone()}
          disabled={busy}
        >
          Not now
        </Button>
      </div>
    </WizardStepBody>
  );
}

function BatteryStep({ onDone }: { onDone: () => void }) {
  const [busy, setBusy] = useState(false);

  const allow = async () => {
    setBusy(true);
    try {
      await requestIgnoreBatteryOptimizations();
    } catch {
      // The OS dialog may be unavailable; the settings warning remains.
    } finally {
      // The step advances either way: an OS that declined to show the dialog
      // (already exempt, OEM without the intent) is indistinguishable from one
      // that showed it, and a step that stays put reads as a dead button.
      setBusy(false);
      onDone();
    }
  };

  return (
    <WizardStepBody
      glyph={
        <StepGlyph>
          <BatteryCharging className="size-9" />
        </StepGlyph>
      }
      title="keep it connected"
      description="Android's battery optimization suspends Armada's connection in the background, which silently stops notifications. Allowing background usage keeps them arriving."
    >
      <div className="w-full space-y-3">
        <Button
          size="lg"
          className="h-12 w-full clip-corner-lg text-base font-medium"
          onClick={allow}
          disabled={busy}
        >
          Allow background usage
        </Button>
        <Button
          variant="ghost"
          className="w-full text-muted-foreground"
          onClick={onDone}
          disabled={busy}
        >
          Not now
        </Button>
      </div>
    </WizardStepBody>
  );
}

function DecryptStep({ onDone }: { onDone: () => void }) {
  const choose = (value: "allowed" | "declined") => {
    setDecryptConsent(value);
    onDone();
  };

  return (
    <WizardStepBody
      glyph={
        <StepGlyph>
          <Lock className="size-9" />
        </StepGlyph>
      }
      title="decrypt your messages"
      description="Your messages are end-to-end encrypted. Armada needs your signer to unlock them."
    >
      <div className="w-full space-y-3">
        <div className="clip-corner-lg bg-secondary/40 p-3 text-left">
          <p className="text-xs text-muted-foreground">
            Allow it once and Armada decrypts quietly from here on. Decline and messages stay
            locked until you tap <strong>Decrypt</strong> on them.
          </p>
        </div>

        <Button
          size="lg"
          className="h-12 w-full clip-corner-lg text-base font-medium"
          onClick={() => choose("allowed")}
        >
          Decrypt my messages
        </Button>
        <Button
          variant="ghost"
          className="w-full text-muted-foreground"
          onClick={() => choose("declined")}
        >
          Not now
        </Button>
      </div>
    </WizardStepBody>
  );
}
