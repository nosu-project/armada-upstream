import { Capacitor } from "@capacitor/core";
import { BatteryCharging, Bell, Lock, Waypoints } from "lucide-react";
import { useCallback, useEffect, useState, type ReactNode } from "react";

import { WizardShell, WizardStepBody } from "@/components/onboarding/WizardShell";
import { useSyncGateActive } from "@/components/syncGateState";
import { Button } from "@/components/ui/button";
import { RelayBootstrapForm } from "@/components/RelayBootstrapForm";
import { useAppContext } from "@/hooks/useAppContext";
import { useCurrentUser } from "@/hooks/useCurrentUser";
import { useEncryptedSettings } from "@/hooks/useEncryptedSettings";
import { useLoginActions } from "@/hooks/useLoginActions";
import { useNip29Servers } from "@/hooks/useNip29Servers";
import { useOnboardingActive } from "@/hooks/useOnboarding";
import {
  clearRelayRecoveryPromptShown,
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
 * Post-login setup: one queue of skippable full-screen steps (notification
 * permission, battery exemption, bulk-decrypt consent, …). Steps enqueue only
 * when they apply, and the flow waits while the sync gate is up.
 */

type StepId = "relays" | "notifications" | "webpush" | "battery" | "decrypt";

/** Set once the notification step was shown; declined steps aren't re-asked (Settings is the way back). */
const NOTIF_PROMPT_KEY = "armada:notif-prompt-shown";



/** Set once the battery step was shown. Original key kept so older releases' timestamps count. */
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
  } catch { /* ignore */ }
}

async function batteryStepApplies(): Promise<boolean> {
  if (Capacitor.getPlatform() !== "android") return false;
  if (read(BATTERY_PROMPT_KEY)) return false;
  return !(await isIgnoringBatteryOptimizations());
}

export function LoginSetup() {
  const { user } = useCurrentUser();
  const { config } = useAppContext();
  const syncing = useSyncGateActive();
  // Signup logs in before profile steps render, so hold every step until the
  // wizard is done or one paints over it at z-[260].
  const onboarding = useOnboardingActive();

  const { logout } = useLoginActions();
  const [queue, setQueue] = useState<StepId[]>([]);
  const [completed, setCompleted] = useState(0);
  const [leaving, setLeaving] = useState(false);
  // Backing out logs out, which wipes this device's data, so confirm first.
  const [confirmingBack, setConfirmingBack] = useState(false);
  const ownsRelayList = user
    ? !config.relayMetadata.pubkey || config.relayMetadata.pubkey === user.pubkey
    : false;
  const hasSignedRelayList = ownsRelayList && config.relayMetadata.relays.length > 0;

  // Only prompt for recovery when sync found nothing (no relay list, settings, or servers).
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

  // Demand-driven: opened the first time a surface needs an uncached decrypt.
  useEffect(() => registerConsentPromptOpener(() => enqueue("decrypt")), [enqueue]);

  // WebPushNotifications knows when a fresh user could receive push.
  useEffect(() => registerWebPushOptInOpener(() => enqueue("webpush")), [enqueue]);

  // Genuine recovery case only (existing account, setup not found). Skips are remembered per account.
  useEffect(() => {
    if (!user || syncing || onboarding) return;
    // Restore can settle across renders; drop a stale prompt when data arrives.
    if (hasRestoredData) {
      setQueue((current) => current.filter((candidate) => candidate !== "relays"));
      return;
    }
    // An in-flight settings read looks empty; don't mistake a slow relay for "nothing found".
    if (!settingsFetched) return;
    if (relayRecoveryPromptShown(user.pubkey)) return;
    enqueue("relays");
  }, [user, syncing, onboarding, hasRestoredData, settingsFetched, enqueue]);

  // Release pending decrypt callers as "not now" on unmount, or they hang forever.
  useEffect(() => {
    return () => resolveConsentPrompt("declined");
  }, []);

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
        if (await batteryStepApplies()) {
          if (!cancelled) enqueue("battery");
        }
      } catch {
        // Probe failed: offer nothing rather than guess.
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [user, syncing, onboarding, enqueue]);

  const step = queue[0];

  // Record at render so a force-quit mid-flow isn't re-asked every launch.
  useEffect(() => {
    if (step === "relays" && user?.pubkey) markRelayRecoveryPromptShown(user.pubkey);
    if (step === "notifications") write(NOTIF_PROMPT_KEY, "1");
    if (step === "webpush") markWebPushPromptShown();
    if (step === "battery") write(BATTERY_PROMPT_KEY, "1");
  }, [step, user?.pubkey]);

  // Avoid a contradictory frame while the relay step is being removed.
  if (!step || syncing || onboarding || (step === "relays" && hasRestoredData)) return null;

  const total = completed + queue.length;

  // Backing out of the first step signs the account out; the marker goes too.
  const backOutOfLogin = step === "relays" && completed === 0 && user && !leaving
    ? () => {
      setLeaving(true);
      clearRelayRecoveryPromptShown(user.pubkey);
      void logout().catch(() => setLeaving(false));
    }
    : undefined;
  const requestBack = backOutOfLogin ? () => setConfirmingBack(true) : undefined;

  return (
    <WizardShell
      index={completed}
      total={total}
      stepKey={step}
      zClassName="z-[260]"
      onBack={requestBack}
    >
      {step === "notifications" && (
        <NotificationsStep
          onDone={async (granted) => {
            // Granting is what makes the exemption matter, so chain into it.
            if (granted && (await batteryStepApplies())) enqueue("battery");
            advance();
          }}
        />
      )}
      {step === "relays" && (
        <RelayStep
          onDone={advance}
          onBack={requestBack}
          confirmingBack={confirmingBack && !!backOutOfLogin}
          onConfirmBack={backOutOfLogin}
          onCancelBack={() => setConfirmingBack(false)}
        />
      )}
      {step === "webpush" && <WebPushStep onDone={advance} />}
      {step === "battery" && <BatteryStep onDone={advance} />}
      {step === "decrypt" && <DecryptStep onDone={advance} />}
    </WizardShell>
  );
}

function RelayStep({
  onDone,
  onBack,
  confirmingBack,
  onConfirmBack,
  onCancelBack,
}: {
  onDone: () => void;
  onBack?: () => void;
  confirmingBack: boolean;
  onConfirmBack?: () => void;
  onCancelBack: () => void;
}) {
  // Escape backs out like the arrow, unless spent on a popover (default
  // prevented), inside a text field, or ending an IME composition.
  useEffect(() => {
    if (!onBack) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "Escape" || e.defaultPrevented || e.isComposing) return;
      if (!confirmingBack && isEditableTarget(e.target)) return;
      if (confirmingBack) onCancelBack();
      else onBack();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onBack, confirmingBack, onCancelBack]);

  if (confirmingBack && onConfirmBack) {
    return (
      <WizardStepBody
        glyph={
          <StepGlyph>
            <Waypoints className="size-9" />
          </StepGlyph>
        }
        title="sign out?"
        description="Going back signs this account out of Armada on this device, and removes what this device has stored for it. Your key and anything on your relays are not affected."
      >
        <div className="flex flex-col gap-2">
          <Button variant="destructive" onClick={onConfirmBack}>
            Sign out
          </Button>
          <Button variant="ghost" onClick={onCancelBack}>
            Stay signed in
          </Button>
        </div>
      </WizardStepBody>
    );
  }

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

function isEditableTarget(target: EventTarget | null): boolean {
  return target instanceof HTMLElement
    && (target.isContentEditable || /^(input|textarea|select)$/i.test(target.tagName));
}

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

/** Web/PWA counterpart to `NotificationsStep`; copy is honest that a push service is involved. */
function WebPushStep({ onDone }: { onDone: () => void }) {
  const [busy, setBusy] = useState(false);
  // Foreground mode must not promise closed-app delivery.
  const foreground = webPushOptInMode() === "foreground";

  const enable = async () => {
    setBusy(true);
    try {
      // This click is the gesture that grants Notification permission.
      await runWebPushEnable();
    } catch {
      // Denied or subscribe failed; the Settings toggle remains.
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
        ? "Armada can notify you about direct messages, mentions and replies while it's open, even behind another window. This browser can't deliver notifications once Armada is closed, so nothing leaves your device for them."
        : "Armada can notify you about direct messages, mentions and replies even while it's closed. Notifications go through your browser's push service but carry no message content. Armada decrypts them on your device."}
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
    } catch { /* ignore */ } finally {
      // Advance either way: an OS that didn't show the dialog is indistinguishable from one that did.
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
