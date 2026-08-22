import { useEffect, useState } from "react";
import { AlertTriangle, Play } from "lucide-react";

import { useCurrentUser } from "@/hooks/useCurrentUser";
import { useForegroundNotificationSettings } from "@/hooks/useForegroundNotificationSettings";
import {
  useNativeNotifications,
  type UseNativeNotificationsReturn,
} from "@/hooks/useNativeNotifications";
import { useWebPushNotifications } from "@/contexts/WebPushContext";
import {
  loadNotificationSoundSettings,
  NOTIFICATION_SOUNDS,
  NOTIFICATION_SOUND_SETTINGS_KEY,
  playNotificationSound,
  saveNotificationSoundSettings,
  type NotificationSoundId,
  type NotificationSoundSettings as NotificationSoundSettingsValue,
} from "@/lib/notificationSounds";
import { hasIosPush } from "@/lib/nativePush";
import { type DmRequestLevel, type PushPrefs } from "@/lib/pushPrefs";
import type { WebPushUnavailableReason } from "@/lib/webPushSupport";
import {
  isIgnoringBatteryOptimizations,
  requestIgnoreBatteryOptimizations,
} from "@/lib/nativeNotifications";
import { isIOS, isNativeRuntime, isStandalonePwa } from "@/lib/platform";

import { Button } from "@/components/ui/button";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Slider } from "@/components/ui/slider";
import { Switch } from "@/components/ui/switch";

/**
 * Notification settings.
 *
 * Two delivery paths, picked by runtime:
 *  - Native APK: a foreground service holds a persistent relay connection and
 *    fires local notifications instantly (no FCM/Google). See
 *    useNativeNotifications.
 *  - Web / PWA: Web Push via a content-blind nostr-push gateway. See
 *    useWebPushNotifications.
 *
 * Both expose the same Discord-style per-type toggles.
 */
export function NotificationSettings() {
  const { user } = useCurrentUser();
  const native = useNativeNotifications();

  if (!user) {
    return <p className="text-sm text-muted-foreground">Log in to enable notifications.</p>;
  }

  // Native APK: instant background notifications via the relay connection.
  if (native.supported) {
    return (
      <div className="space-y-4">
        <NotificationToggles
          title="Background notifications"
          description="Armada stays connected in the background and notifies you instantly — no Google services."
          enabled={native.enabled}
          busy={native.busy}
          blocked={false}
          prefs={native.prefs}
          onToggle={(v) => (v ? native.enable() : native.disable())}
          onSetPrefs={(p) => native.setPrefs(p).catch(() => {})}
        />
        <NativeNotificationHealthPanel native={native} />
        {native.enabled && <BatteryOptimizationWarning />}
      </div>
    );
  }

  return (
    <div className="space-y-6">
      <WebPushSettings />
      {!isNativeRuntime() && <NotificationSoundSettings />}
    </div>
  );
}

/** Permission/channel blocks and a compact, non-secret service diagnostic. */
function NativeNotificationHealthPanel({
  native,
}: {
  native: UseNativeNotificationsReturn;
}) {
  const health = native.health;
  if (!health) return null;

  const appBlocked = !health.postNotificationsGranted || !health.notificationsEnabled;
  const messagesBlocked = health.messageChannelImportance === 0;
  const messagesQuiet = health.messageChannelImportance > 0 &&
    health.messageChannelImportance < 4;
  const callsBlocked = health.callChannelImportance === 0;
  const callsQuiet = health.callChannelImportance > 0 && health.callChannelImportance < 4;
  const serviceBlocked = health.serviceChannelImportance === 0;
  const stopped = native.enabled && (!health.configEnabled || !health.serviceRunning);
  const staleConfig = native.enabled && health.serviceRunning &&
    health.loadedConfigRevision !== health.configRevision;
  const disconnected = native.enabled && health.socketTotalCount > 0 &&
    health.socketOpenCount === 0;
  const signerUnavailable = native.enabled && health.signerStatus === "unavailable";
  const blocked = appBlocked || messagesBlocked;
  const degraded = messagesQuiet || callsQuiet || stopped || staleConfig || disconnected ||
    serviceBlocked || signerUnavailable ||
    health.authStatus === "rejected" || health.authStatus === "failed";

  const open = (channel?: "messages" | "calls" | "service") => {
    void native.openSettings(channel).catch(() => {});
  };

  return (
    <div className="space-y-3">
      {(blocked || degraded || callsBlocked) && (
        <div className="rounded-lg border border-amber-500/40 bg-amber-500/10 p-3">
          <div className="flex items-start gap-2">
            <AlertTriangle className="mt-0.5 size-4 shrink-0 text-amber-500" />
            <div className="min-w-0 flex-1 space-y-2">
              <p className="text-xs">
                {appBlocked
                  ? "Android is blocking Armada notifications at the app level."
                  : messagesBlocked
                    ? "Android's Armada message channel is turned off."
                    : messagesQuiet
                      ? "Android's Armada message channel is below high priority, so alerts may be silent or have no banner."
                    : stopped
                      ? "The background notification service is not running with a complete configuration."
                      : staleConfig
                        ? "The background service has not loaded the latest notification configuration."
                      : disconnected
                        ? "The service is running, but none of its relay connections are open."
                        : serviceBlocked
                          ? "The background-service notification channel is turned off. Android may stop the connection."
                          : signerUnavailable
                            ? "The background signer is unavailable, so encrypted DMs and relay authentication can fail while Armada is closed."
                            : callsBlocked
                              ? "Android's incoming-call notification channel is turned off."
                              : "Android's incoming-call channel is below high priority, so calls may not ring."}
              </p>
              <div className="flex flex-wrap gap-2">
                {(appBlocked || messagesBlocked || messagesQuiet) && (
                  <Button
                    size="sm"
                    variant="outline"
                    className="h-8 text-xs"
                    onClick={() => open(appBlocked ? undefined : "messages")}
                  >
                    Open notification settings
                  </Button>
                )}
                {(callsBlocked || callsQuiet) && (
                  <Button
                    size="sm"
                    variant="outline"
                    className="h-8 text-xs"
                    onClick={() => open("calls")}
                  >
                    Open call settings
                  </Button>
                )}
                {serviceBlocked && (
                  <Button
                    size="sm"
                    variant="outline"
                    className="h-8 text-xs"
                    onClick={() => open("service")}
                  >
                    Open service settings
                  </Button>
                )}
              </div>
            </div>
          </div>
        </div>
      )}

      <details className="rounded-lg border border-border px-3 py-2 text-xs">
        <summary className="cursor-pointer font-medium">Notification diagnostics</summary>
        <dl className="mt-3 grid grid-cols-[minmax(0,1fr)_auto] gap-x-4 gap-y-1 text-muted-foreground">
          <dt>Service / config</dt>
          <dd className="text-right text-foreground">
            {health.serviceRunning ? "running" : "stopped"} / {health.configEnabled
              ? health.loadedConfigRevision === health.configRevision ? "loaded" : "stale"
              : "off"}
          </dd>
          <dt>Watches</dt>
          <dd className="text-right text-foreground">
            {health.relayWatchCount} relays · {health.groupWatchCount} groups · {health.dmPeerWatchCount} DMs · {health.concordStreamWatchCount} streams
          </dd>
          <dt>Relay sockets</dt>
          <dd className="text-right text-foreground">
            {health.socketOpenCount}/{health.socketTotalCount} open
          </dd>
          <dt>Message / call / service channels</dt>
          <dd className="text-right text-foreground">
            {formatImportance(health.messageChannelImportance)} / {formatImportance(health.callChannelImportance)} / {formatImportance(health.serviceChannelImportance)}
          </dd>
          <dt>Signer / relay auth</dt>
          <dd className="text-right text-foreground">
            {health.signerStatus} / {health.authStatus}
          </dd>
          <dt>Last config / sign / auth</dt>
          <dd className="text-right text-foreground">
            {formatHealthTime(health.lastConfigAt)} / {formatHealthTime(health.lastSignAt)} / {formatHealthTime(health.lastAuthAt)}
          </dd>
          <dt>Last relay event</dt>
          <dd className="text-right text-foreground">{formatHealthTime(health.lastEventAt)}</dd>
          <dt>Last notification post</dt>
          <dd className="text-right text-foreground">{formatHealthTime(health.lastPresentedAt)}</dd>
          <dt>Active notifications</dt>
          <dd className="text-right text-foreground">{health.activeNotificationCount}</dd>
          <dt>Last error</dt>
          <dd className="text-right text-foreground">
            {health.lastError
              ? `${health.lastError} · ${formatHealthTime(health.lastErrorAt)}`
              : "none"}
          </dd>
        </dl>
        <Button
          size="sm"
          variant="ghost"
          className="mt-2 h-8 px-2 text-xs"
          onClick={() => void native.refreshHealth()}
        >
          Refresh
        </Button>
      </details>
    </div>
  );
}

function formatHealthTime(timestamp: number): string {
  if (!timestamp) return "never";
  return new Date(timestamp).toLocaleString();
}

function formatImportance(importance: number): string {
  return ["blocked", "min", "low", "default", "high", "max"][importance] ?? "n/a";
}

/** Sound played by the open web/desktop client; native platforms own audio. */
function NotificationSoundSettings() {
  const [settings, setSettings] = useState<NotificationSoundSettingsValue>(
    loadNotificationSoundSettings,
  );

  useEffect(() => {
    const syncFromStorage = (event: StorageEvent) => {
      if (event.key === NOTIFICATION_SOUND_SETTINGS_KEY) {
        setSettings(loadNotificationSoundSettings());
      }
    };
    window.addEventListener("storage", syncFromStorage);
    return () => window.removeEventListener("storage", syncFromStorage);
  }, []);

  const update = (patch: Partial<NotificationSoundSettingsValue>) => {
    setSettings((current) => saveNotificationSoundSettings({ ...current, ...patch }));
  };

  return (
    <div className="space-y-4 border-t border-border pt-5">
      <label className="flex cursor-pointer items-center justify-between gap-4">
        <span className="text-sm font-medium">
          Notification sound
          <span className="block text-xs font-normal text-muted-foreground">
            Play a chosen sound for new activity while Armada is open.
          </span>
        </span>
        <Switch
          checked={settings.enabled}
          onCheckedChange={(enabled) => update({ enabled })}
        />
      </label>

      {settings.enabled && (
        <div className="space-y-4">
          <div className="flex items-end gap-2">
            <label className="min-w-0 flex-1 space-y-1.5">
              <span className="text-xs font-medium text-muted-foreground">Sound</span>
              <Select
                value={settings.sound}
                onValueChange={(sound) => update({ sound: sound as NotificationSoundId })}
              >
                <SelectTrigger aria-label="Notification sound">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {NOTIFICATION_SOUNDS.map((sound) => (
                    <SelectItem key={sound.id} value={sound.id}>
                      {sound.label} — {sound.creator}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </label>
            <Button
              type="button"
              size="sm"
              variant="outline"
              className="h-10 gap-2 touch:h-11"
              onClick={() => playNotificationSound({ settings, preview: true })}
            >
              <Play className="size-4" />
              Preview
            </Button>
          </div>

          <label className="block space-y-2">
            <span className="flex items-center justify-between gap-4 text-xs font-medium text-muted-foreground">
              <span>Volume</span>
              <span>{Math.round(settings.volume * 100)}%</span>
            </span>
            <Slider
              aria-label="Notification sound volume"
              className="touch:h-11"
              min={0}
              max={1}
              step={0.05}
              value={[settings.volume]}
              onValueChange={([volume]) => update({ volume })}
            />
          </label>
        </div>
      )}

      <p className="text-xs text-muted-foreground">
        Background push and Android use the sound selected by your device. Browsers may require
        one interaction with Armada before allowing in-page audio. Sounds are CC0 or CC BY-SA;
        see the{" "}
        <a
          className="underline underline-offset-2 hover:text-foreground"
          href="/sounds/notifications/LICENSES.md"
          target="_blank"
          rel="noreferrer"
        >
          sound credits
        </a>
        .
      </p>
    </div>
  );
}

/**
 * Warns when Android battery optimization is still active for Armada.
 *
 * Battery optimization tears down the persistent relay websockets while the
 * device is idle, and on Android 15+ it also prevents the boot receiver from
 * restarting the service after a reboot. Offers the one-tap system exemption
 * dialog and re-checks when the user returns from it.
 */
function BatteryOptimizationWarning() {
  const [optimized, setOptimized] = useState(false);

  useEffect(() => {
    let cancelled = false;
    const check = () => {
      isIgnoringBatteryOptimizations().then((ignoring) => {
        if (!cancelled) setOptimized(!ignoring);
      });
    };

    check();

    // Re-check when the user returns from the system exemption dialog.
    const onVisibilityChange = () => {
      if (document.visibilityState === "visible") check();
    };
    document.addEventListener("visibilitychange", onVisibilityChange);

    return () => {
      cancelled = true;
      document.removeEventListener("visibilitychange", onVisibilityChange);
    };
  }, []);

  if (!optimized) return null;

  return (
    <div className="rounded-lg border border-amber-500/40 bg-amber-500/10 p-3">
      <div className="flex items-start gap-2">
        <AlertTriangle className="mt-0.5 size-4 shrink-0 text-amber-500" />
        <div className="min-w-0 flex-1">
          <p className="text-xs">
            Battery optimization is enabled for Armada. Android may close the background
            connection while your device is idle and prevent notifications from resuming
            after a reboot.
          </p>
          <Button
            size="sm"
            variant="outline"
            className="mt-2 h-8 text-xs"
            onClick={() => requestIgnoreBatteryOptimizations()}
          >
            Disable battery optimization
          </Button>
        </div>
      </div>
    </div>
  );
}

function WebPushSettings() {
  // The content-blind nostr-push path, which self-gates on `supported` when no
  // push server is configured for this build.
  const {
    supported,
    unavailableReason,
    ready,
    error,
    permission,
    enabled,
    busy,
    prefs,
    enable,
    disable,
    setPrefs,
    retry,
  } = useWebPushNotifications();

  // Browsers where Web Push is unavailable (Brave with Google push services
  // off, or no configured push gateway) still get FOREGROUND OS notifications
  // while Armada is open. Surface those controls instead of a dead end.
  if (!supported) {
    // iOS exposes Web Push (and even the Notification API) only to a
    // Home-Screen web app on iOS 16.4+, and every iOS browser is WKWebView
    // underneath — so the "use Chrome/Firefox/Android app" advice in the
    // foreground fallback is impossible here, and the foreground notifier is
    // just as unavailable. Show iOS-specific guidance instead.
    if (isIOS()) {
      return (
        <IosNotificationHint
          standalone={isStandalonePwa()}
          reason={unavailableReason}
        />
      );
    }
    return <ForegroundOnlySettings />;
  }

  if (error) {
    return (
      <div className="space-y-3">
        <div className="flex items-start gap-2 text-sm text-muted-foreground">
          <AlertTriangle className="mt-0.5 size-4 shrink-0 text-amber-500" />
          <p>{error}</p>
        </div>
        <Button size="sm" variant="outline" onClick={retry}>
          Retry notification setup
        </Button>
      </div>
    );
  }

  return (
    <NotificationToggles
      title="Enable push notifications"
      description={!ready
        ? "Preparing secure background notifications…"
        : hasIosPush()
          // The iOS app has no Notification Service Extension yet, so the
          // gateway's fixed wake-up text is what the lock screen shows. Say so
          // rather than let it read as a bug.
          ? "Get notified even when Armada is closed. Notifications say a new message arrived without naming the sender or quoting it — Armada only decrypts once you open it."
          : "Get notified even when Armada is closed. Armada repairs expired browser subscriptions whenever you return."}
      enabled={enabled}
      busy={busy}
      blocked={permission === "denied"}
      blockedMessage={isIOS()
        ? "Notifications are blocked. Allow Armada in iPhone Settings → Notifications."
        : "Notifications are blocked in your browser settings."}
      prefs={prefs}
      onToggle={(v) => (v ? enable() : disable())}
      onSetPrefs={(p) => setPrefs(p).catch(() => {})}
    />
  );
}

/**
 * iOS notification guidance, shown whenever Web Push is unavailable on iOS.
 *
 * iOS delivers Web Push only to a Home-Screen web app on iOS 16.4+, and every
 * iOS browser is WKWebView — so the generic "use Chrome/Firefox/Android app"
 * fallback is wrong here. The copy adapts:
 *  - Service Worker API absent → the substrate for Web Push is switched off at
 *    the device level, which on iOS is what Lockdown Mode does (content
 *    blockers can too). Reinstalling won't help.
 *  - Not installed → guide to Add to Home Screen.
 *  - Installed but still no push → iOS 16.4+ / re-add guidance.
 */
function IosNotificationHint({
  standalone,
  reason,
}: {
  standalone: boolean;
  reason?: WebPushUnavailableReason;
}) {
  // Only an iOS app built before push notifications existed reaches this now:
  // a current one registers an APNs token with the same gateway the web client
  // uses (useIosPush), and a browser reports the layer that is actually missing.
  if (reason === "native-runtime") {
    return (
      <p className="text-sm text-muted-foreground">
        This version of the Armada app can&rsquo;t receive background notifications. Update to a
        newer build to turn them on.
      </p>
    );
  }

  if (reason === "gateway") {
    return (
      <p className="text-sm text-muted-foreground">
        This build of Armada has no background push service configured. Your iPhone is not the
        problem; whoever built or deployed it needs to configure a push gateway.
      </p>
    );
  }

  // No Service Worker API at all — Web Push is built on it, so nothing here can
  // enable notifications until the device-level block is lifted. On iOS this is
  // the signature of Lockdown Mode (which disables service workers and Web
  // Push); a content blocker or a disabled WebKit feature flag can do the same.
  if (reason === "service-worker") {
    return (
      <div className="space-y-2">
        <p className="text-sm text-muted-foreground">
          Notifications need service workers, which are switched off on this device.
        </p>
        <p className="text-xs text-muted-foreground">
          If <strong>Lockdown Mode</strong> is on (Settings → Privacy &amp; Security → Lockdown
          Mode), it disables web notifications — turn it off, or exclude Armada under its
          &ldquo;Configure Web Browsing&rdquo; / Safari exceptions, to use them. A content blocker
          can have the same effect.
        </p>
      </div>
    );
  }

  if (!standalone) {
    return (
      <div className="space-y-2">
        <p className="text-sm text-muted-foreground">
          To get notifications on iPhone or iPad, open Armada in Safari, tap Share, choose
          <strong> Add to Home Screen</strong>, keep <strong>Open as Web App</strong> turned on,
          then launch Armada from the new icon.
        </p>
        <p className="text-xs text-muted-foreground">
          iOS only delivers notifications to apps installed on the Home Screen, not to sites open
          in a browser tab.
        </p>
      </div>
    );
  }
  if (reason === "insecure-context") {
    return (
      <p className="text-sm text-muted-foreground">
        Background notifications require Armada to be served over HTTPS.
      </p>
    );
  }

  return (
    <div className="space-y-2">
      <p className="text-sm text-muted-foreground">
        Armada is open as a Home Screen app, but iOS has not exposed Web Push to this install.
        Update iOS, check that Lockdown Mode is not blocking Armada, then remove and add it again
        with <strong>Open as Web App</strong> turned on.
      </p>
      <p className="text-xs text-muted-foreground">
        Web Push requires iOS 16.4 or later. Reinstalling is only useful for this specific missing
        API state; it is not a general fix for a broken subscription.
      </p>
    </div>
  );
}

/**
 * Foreground-only notifications for browsers without Web Push (e.g. Brave).
 * Fires OS notifications while Armada is open (needs Notification permission);
 * for closed-app delivery the user needs a browser that supports Web Push, or
 * the Android app.
 */
function ForegroundOnlySettings() {
  const { apiAvailable, permission, enabled, setEnabled, prefs, setPrefs } =
    useForegroundNotificationSettings();

  const blocked = apiAvailable && permission === "denied";

  if (!apiAvailable) {
    return (
      <p className="text-sm text-muted-foreground">
        This browser doesn&rsquo;t support notifications. Use Chrome, Firefox, or the Android app.
      </p>
    );
  }

  return (
    <div className="space-y-4">
      <NotificationToggles
        title="Notifications while Armada is open"
        description="This browser doesn't support background push, so notifications only arrive while Armada is open. You'll get a system notification for new messages when you're not looking at the conversation."
        enabled={enabled}
        busy={false}
        blocked={blocked}
        blockedMessage="Notifications are blocked in your browser settings."
        // Distinct from blocked, and the state this panel spent a long time
        // showing as simply "on": the master wish defaults to on, so without
        // saying so here a profile that has never been asked looks enabled and
        // silently never fires.
        hint={apiAvailable && permission === "default"
          ? "Your browser hasn't allowed notifications yet — turn this on to ask."
          : undefined}
        prefs={prefs}
        onToggle={(v) => setEnabled(v).catch(() => {})}
        onSetPrefs={setPrefs}
      />
      <p className="text-xs text-muted-foreground">
        For notifications when Armada is closed, use a browser that supports Web Push (Chrome,
        Firefox, or Brave with Google push services enabled), or the Android app.
      </p>
    </div>
  );
}

function NotificationToggles(props: {
  title: string;
  description?: string;
  enabled: boolean;
  busy: boolean;
  blocked: boolean;
  blockedMessage?: string;
  /** An advisory note below the description — unlike `blocked`, actionable. */
  hint?: string;
  prefs: PushPrefs;
  onToggle: (value: boolean) => void;
  onSetPrefs: (next: PushPrefs) => void;
}) {
  const { title, description, enabled, busy, blocked, blockedMessage, hint, prefs } = props;

  const setPref = (key: keyof PushPrefs) => (value: boolean) => {
    props.onSetPrefs({ ...prefs, [key]: value });
  };

  const setDmRequests = (value: DmRequestLevel) => {
    props.onSetPrefs({ ...prefs, dmRequests: value });
  };

  return (
    <div className="space-y-5">
      <label className="flex items-center justify-between gap-4 cursor-pointer">
        <span className="text-sm font-medium">
          {title}
          {description && (
            <span className="block text-xs font-normal text-muted-foreground">{description}</span>
          )}
          {blocked && blockedMessage && (
            <span className="block text-xs font-normal text-destructive">{blockedMessage}</span>
          )}
          {!blocked && hint && (
            <span className="block text-xs font-normal text-amber-500">{hint}</span>
          )}
        </span>
        <Switch checked={enabled} disabled={busy || blocked} onCheckedChange={props.onToggle} />
      </label>

      {enabled && (
        <div className="space-y-4 border-t border-border pt-4">
          <h3 className="text-sm font-semibold text-muted-foreground">Notify me about</h3>

          <PrefRow
            label="Mentions"
            description="When someone @-mentions you in a channel."
            checked={prefs.mentions}
            disabled={busy}
            onChange={setPref("mentions")}
          />
          <PrefRow
            label="Replies"
            description="When someone replies to your message."
            checked={prefs.replies}
            disabled={busy}
            onChange={setPref("replies")}
          />
          <PrefRow
            label="Reactions"
            description="When someone reacts to your message."
            checked={prefs.reactions}
            disabled={busy}
            onChange={setPref("reactions")}
          />
          <PrefRow
            label="Direct messages"
            description="When you receive a DM."
            checked={prefs.directMessages}
            disabled={busy}
            onChange={setPref("directMessages")}
          />
          {prefs.directMessages && (
            <label className="flex items-center justify-between gap-4 pl-4">
              <span className="min-w-0">
                <span className="block text-sm font-medium">Message requests</span>
                <span className="block text-xs font-normal text-muted-foreground">
                  DMs from people you don't follow. A stranger controls the text,
                  name and picture a notification shows.
                </span>
              </span>
              <Select
                value={prefs.dmRequests}
                onValueChange={(v) => setDmRequests(v as DmRequestLevel)}
                disabled={busy}
              >
                <SelectTrigger className="w-36 shrink-0">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="full">Show fully</SelectItem>
                  <SelectItem value="generic">Hide content</SelectItem>
                  <SelectItem value="off">Don't notify</SelectItem>
                </SelectContent>
              </Select>
            </label>
          )}
          <PrefRow
            label="All channel messages"
            description="Every message in your channels, not just mentions. Noisy in busy servers."
            checked={prefs.allGroupMessages}
            disabled={busy}
            onChange={setPref("allGroupMessages")}
          />
        </div>
      )}
    </div>
  );
}

function PrefRow(props: {
  label: string;
  description: string;
  checked: boolean;
  disabled?: boolean;
  onChange: (value: boolean) => void;
}) {
  return (
    <label className="flex items-center justify-between gap-4 cursor-pointer">
      <span className="min-w-0">
        <span className="block text-sm font-medium">{props.label}</span>
        <span className="block text-xs text-muted-foreground">{props.description}</span>
      </span>
      <Switch checked={props.checked} disabled={props.disabled} onCheckedChange={props.onChange} />
    </label>
  );
}
