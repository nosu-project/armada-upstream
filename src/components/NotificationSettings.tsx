import { useEffect, useState, type ReactNode } from "react";
import { AlertTriangle, Play } from "lucide-react";

import { SettingsGroup, SettingsRow } from "@/components/settings/SettingsSection";
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
import { hasNappPush } from "@/lib/nappPush";
import { type DmRequestLevel, type PushPrefs } from "@/lib/pushPrefs";
import type { WebPushUnavailableReason } from "@/lib/webPushSupport";
import {
  isIgnoringBatteryOptimizations,
  requestIgnoreBatteryOptimizations,
} from "@/lib/nativeNotifications";
import { isIOS, isNativeRuntime, isStandalonePwa } from "@/lib/platform";
import { isDesktop } from "@/lib/desktop";

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
 * Notification settings. Native APK: a foreground service with a persistent
 * relay connection (no FCM; see useNativeNotifications). Web/PWA: Web Push via
 * a content-blind nostr-push gateway (see useWebPushNotifications).
 */
export function NotificationSettings() {
  const { user } = useCurrentUser();
  const native = useNativeNotifications();

  if (!user) {
    return <NoticeGroup>Log in to enable notifications.</NoticeGroup>;
  }

  if (native.supported) {
    return (
      <>
        {native.enabled && <BatteryOptimizationWarning />}
        <NotificationToggles
          title="Background notifications"
          description="Get notified even when Armada is closed."
          info="Armada stays connected in the background to notify you, without Google services."
          enabled={native.enabled}
          busy={native.busy}
          blocked={false}
          prefs={native.prefs}
          onToggle={(v) => (v ? native.enable() : native.disable())}
          onSetPrefs={(p) => native.setPrefs(p).catch(() => {})}
        />
        <NativeNotificationHealthPanel native={native} />
      </>
    );
  }

  return (
    <>
      <WebPushSettings />
      {!isNativeRuntime() && <NotificationSoundSettings />}
    </>
  );
}

/** A group holding only explanatory copy, for states with nothing to toggle. */
function NoticeGroup({ children }: { children: ReactNode }) {
  return (
    <SettingsGroup>
      <SettingsRow>
        <div className="space-y-2 text-sm text-muted-foreground">{children}</div>
      </SettingsRow>
    </SettingsGroup>
  );
}

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
    <SettingsGroup title="Status">
      {(blocked || degraded || callsBlocked) && (
        <SettingsRow className="bg-warning/10">
          <div className="flex items-start gap-2">
            <AlertTriangle className="mt-0.5 size-4 shrink-0 text-warning" />
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
                    variant="secondary"
                    className="h-8 text-xs touch:h-11"
                    onClick={() => open(appBlocked ? undefined : "messages")}
                  >
                    Open notification settings
                  </Button>
                )}
                {(callsBlocked || callsQuiet) && (
                  <Button
                    size="sm"
                    variant="secondary"
                    className="h-8 text-xs touch:h-11"
                    onClick={() => open("calls")}
                  >
                    Open call settings
                  </Button>
                )}
                {serviceBlocked && (
                  <Button
                    size="sm"
                    variant="secondary"
                    className="h-8 text-xs touch:h-11"
                    onClick={() => open("service")}
                  >
                    Open service settings
                  </Button>
                )}
              </div>
            </div>
          </div>
        </SettingsRow>
      )}

      <details className="px-4 py-3.5 text-xs">
        <summary className="cursor-pointer text-sm font-medium">Notification diagnostics</summary>
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
          className="mt-2 h-8 px-2 text-xs touch:h-11"
          onClick={() => void native.refreshHealth()}
        >
          Refresh
        </Button>
      </details>
    </SettingsGroup>
  );
}

function formatHealthTime(timestamp: number): string {
  if (!timestamp) return "never";
  return new Date(timestamp).toLocaleString();
}

function formatImportance(importance: number): string {
  return ["blocked", "min", "low", "default", "high", "max"][importance] ?? "n/a";
}

/** Sound for the web/desktop client; native platforms own audio. */
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
    <SettingsGroup title="Sound">
      <SettingsRow
        label="Notification sound"
        description="Plays for new activity while Armada is open."
        info={(
          <>
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
          </>
        )}
      >
        <Switch
          checked={settings.enabled}
          onCheckedChange={(enabled) => update({ enabled })}
        />
      </SettingsRow>

      {settings.enabled && (
        <SettingsRow stack label="Sound">
          <div className="flex items-center gap-2">
            <Select
              value={settings.sound}
              onValueChange={(sound) => update({ sound: sound as NotificationSoundId })}
            >
              <SelectTrigger aria-label="Notification sound" className="min-w-0 flex-1 sm:w-56">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {NOTIFICATION_SOUNDS.map((sound) => (
                  <SelectItem key={sound.id} value={sound.id}>
                    {sound.label} by {sound.creator}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            <Button
              type="button"
              size="icon"
              variant="secondary"
              aria-label="Preview sound"
              className="size-10 shrink-0 clip-corner touch:size-11"
              onClick={() => playNotificationSound({ settings, preview: true })}
            >
              <Play className="size-4" />
            </Button>
          </div>
        </SettingsRow>
      )}

      {settings.enabled && (
        <SettingsRow stack label="Volume">
          <div className="flex items-center gap-3 sm:w-72">
            <Slider
              aria-label="Notification sound volume"
              className="flex-1 touch:h-11"
              min={0}
              max={1}
              step={0.05}
              value={[settings.volume]}
              onValueChange={([volume]) => update({ volume })}
            />
            <span className="w-11 shrink-0 text-right text-sm tabular-nums">{Math.round(settings.volume * 100)}%</span>
          </div>
        </SettingsRow>
      )}
    </SettingsGroup>
  );
}

/**
 * Warns while Android battery optimization is active: it kills relay sockets
 * when idle and, on Android 15+, blocks the boot receiver restart.
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
    <SettingsGroup>
      <SettingsRow className="bg-warning/10">
        <div className="flex items-start gap-2">
          <AlertTriangle className="mt-0.5 size-4 shrink-0 text-warning" />
          <div className="min-w-0 flex-1">
            <p className="text-xs">
              Battery optimization can stop notifications while your device is idle or after a reboot.
            </p>
            <Button
              size="sm"
              variant="secondary"
              className="mt-2 h-8 text-xs touch:h-11"
              onClick={() => requestIgnoreBatteryOptimizations()}
            >
              Disable battery optimization
            </Button>
          </div>
        </div>
      </SettingsRow>
    </SettingsGroup>
  );
}

function WebPushSettings() {
  // Web Push through nostr-push2, or Tenna's `window.napp.push`. Self-gates on
  // `supported` when neither is available to this build.
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

  // Without Web Push (Brave with Google push off, no gateway), offer foreground notifications.
  if (!supported) {
    // Every iOS browser is WKWebView and Web Push needs a 16.4+ Home-Screen app,
    // so the foreground fallback's advice doesn't apply.
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
      <SettingsGroup>
        <SettingsRow>
          <div className="space-y-3">
            <div className="flex items-start gap-2 text-sm text-muted-foreground">
              <AlertTriangle className="mt-0.5 size-4 shrink-0 text-warning" />
              <p>{error}</p>
            </div>
            <Button size="sm" variant="secondary" className="touch:h-11" onClick={retry}>
              Retry notification setup
            </Button>
          </div>
        </SettingsRow>
      </SettingsGroup>
    );
  }

  return (
    <NotificationToggles
      title="Enable push notifications"
      description={!ready
        ? "Preparing secure background notifications…"
        : "Get notified even when Armada is closed."}
      info={!ready || hasNappPush()
        ? undefined
        : hasIosPush()
          // No Notification Service Extension yet, so the lock screen shows the gateway's fixed text.
          ? "Notifications don't name the sender or quote the message. Armada decrypts it when you open it."
          : "Armada repairs expired browser subscriptions whenever you return."}
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
 * iOS notification guidance when Web Push is unavailable: Service Worker API
 * absent (Lockdown Mode or content blockers), not installed (Add to Home
 * Screen), or installed without push (iOS 16.4+ / re-add).
 */
function IosNotificationHint(props: { standalone: boolean; reason?: WebPushUnavailableReason }) {
  return (
    <NoticeGroup>
      <IosNotificationHintText {...props} />
    </NoticeGroup>
  );
}

function IosNotificationHintText({
  standalone,
  reason,
}: {
  standalone: boolean;
  reason?: WebPushUnavailableReason;
}) {
  // Only pre-push iOS app builds reach this; current ones register APNs tokens (useIosPush).
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

  // No Service Worker API: on iOS, Lockdown Mode (or a content blocker / WebKit flag).
  if (reason === "service-worker") {
    return (
      <div className="space-y-2">
        <p className="text-sm text-muted-foreground">
          Notifications need service workers, which are switched off on this device.
        </p>
        <p className="text-xs text-muted-foreground">
          If <strong>Lockdown Mode</strong> is on (Settings → Privacy &amp; Security → Lockdown
          Mode), it disables web notifications. To use them, turn it off or exclude Armada under its
          &ldquo;Configure Web Browsing&rdquo; / Safari exceptions. A content blocker
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
 * Foreground-only notifications while Armada is open, where Web Push is
 * unavailable (e.g. Brave, or Electron, which has the Push API but no push
 * service). The desktop shell keeps sockets alive in the tray.
 */
function ForegroundOnlySettings() {
  const { apiAvailable, permission, enabled, setEnabled, prefs, setPrefs } =
    useForegroundNotificationSettings();

  const desktop = isDesktop();
  const blocked = apiAvailable && permission === "denied";

  if (!apiAvailable) {
    return (
      <NoticeGroup>
        {desktop
          ? "This version of Armada can't show notifications."
          : "This browser doesn't support notifications. Use Chrome, Firefox, or the Android app."}
      </NoticeGroup>
    );
  }

  return (
    <NotificationToggles
      title="Notifications while Armada is open"
      description={desktop
        ? "Including when minimized to the tray."
        : "This browser can't notify you while Armada is closed."}
      info={desktop
        ? "Armada shows a system notification for new messages while it's running, including when it's minimized to the tray."
        : "This browser doesn't support background push, so you'll get a system notification for new messages only while Armada is open and you're not looking at the conversation. For notifications when Armada is closed, use a browser that supports Web Push (Chrome, Firefox, or Brave with Google push services enabled), or the Android app."}
      enabled={enabled}
      busy={false}
      blocked={blocked}
      blockedMessage={desktop
        ? "Notifications are blocked. Allow Armada in your system notification settings."
        : "Notifications are blocked in your browser settings."}
      // Permission never asked: the master wish defaults on, so without this it looks enabled but never fires.
      hint={apiAvailable && permission === "default"
        ? desktop
          ? "Armada isn't allowed to notify yet. Turn this on to ask."
          : "Your browser hasn't allowed notifications yet. Turn this on to ask."
        : undefined}
      prefs={prefs}
      onToggle={(v) => setEnabled(v).catch(() => {})}
      onSetPrefs={setPrefs}
    />
  );
}

function NotificationToggles(props: {
  title: string;
  description?: string;
  info?: string;
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
  const { title, description, info, enabled, busy, blocked, blockedMessage, hint, prefs } = props;

  const setPref = (key: keyof PushPrefs) => (value: boolean) => {
    props.onSetPrefs({ ...prefs, [key]: value });
  };

  const setDmRequests = (value: DmRequestLevel) => {
    props.onSetPrefs({ ...prefs, dmRequests: value });
  };

  return (
    <>
      <SettingsGroup id="notifications">
        <SettingsRow
          label={title}
          info={info}
          description={(
            <>
              {description}
              {blocked && blockedMessage && (
                <span className="block text-destructive">{blockedMessage}</span>
              )}
              {!blocked && hint && (
                <span className="block text-warning">{hint}</span>
              )}
            </>
          )}
        >
          <Switch checked={enabled} disabled={busy || blocked} onCheckedChange={props.onToggle} aria-label={title} />
        </SettingsRow>
      </SettingsGroup>

      {enabled && (
        <SettingsGroup title="Notify me about">
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
            <SettingsRow
              stack
              label="Message requests"
              description="DMs from people you don't follow."
              info="A stranger controls the text, name and picture a notification shows."
              className="pl-8"
            >
              <Select
                value={prefs.dmRequests}
                onValueChange={(v) => setDmRequests(v as DmRequestLevel)}
                disabled={busy}
              >
                <SelectTrigger className="w-full sm:w-36" aria-label="Message requests">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="full">Show fully</SelectItem>
                  <SelectItem value="generic">Hide content</SelectItem>
                  <SelectItem value="off">Don't notify</SelectItem>
                </SelectContent>
              </Select>
            </SettingsRow>
          )}
          <PrefRow
            label="All channel messages"
            description="Every message in your channels, not just mentions. Noisy in busy servers."
            checked={prefs.allGroupMessages}
            disabled={busy}
            onChange={setPref("allGroupMessages")}
          />
        </SettingsGroup>
      )}
    </>
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
    <SettingsRow label={props.label} description={props.description}>
      <Switch
        checked={props.checked}
        disabled={props.disabled}
        onCheckedChange={props.onChange}
        aria-label={props.label}
      />
    </SettingsRow>
  );
}
