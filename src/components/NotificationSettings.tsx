import { useEffect, useState } from "react";
import { AlertTriangle } from "lucide-react";

import { useCurrentUser } from "@/hooks/useCurrentUser";
import { useForegroundNotificationSettings } from "@/hooks/useForegroundNotificationSettings";
import { useNativeNotifications } from "@/hooks/useNativeNotifications";
import { useNostrPush } from "@/hooks/useNostrPush";
import { type PushPrefs } from "@/lib/pushPrefs";
import {
  isIgnoringBatteryOptimizations,
  requestIgnoreBatteryOptimizations,
} from "@/lib/nativeNotifications";
import { isIOS, isStandalonePwa } from "@/lib/platform";

import { Button } from "@/components/ui/button";
import { Switch } from "@/components/ui/switch";

/**
 * Notification settings.
 *
 * Two delivery paths, picked by runtime:
 *  - Native APK: a foreground service holds a persistent relay connection and
 *    fires local notifications instantly (no FCM/Google). See
 *    useNativeNotifications.
 *  - Web / PWA: Web Push via a content-blind nostr-push gateway. See
 *    useNostrPush.
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
        {native.enabled && <BatteryOptimizationWarning />}
      </div>
    );
  }

  return <WebPushSettings />;
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
  const { supported, permission, enabled, busy, prefs, enable, disable, setPrefs } =
    useNostrPush();

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
      return <IosNotificationHint standalone={isStandalonePwa()} />;
    }
    return <ForegroundOnlySettings />;
  }

  return (
    <NotificationToggles
      title="Enable push notifications"
      description="Get notified even when Armada is closed. While Armada is open, messages also notify in the foreground."
      enabled={enabled}
      busy={busy}
      blocked={permission === "denied"}
      blockedMessage="Notifications are blocked in your browser settings."
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
function IosNotificationHint({ standalone }: { standalone: boolean }) {
  // No Service Worker API at all — Web Push is built on it, so nothing here can
  // enable notifications until the device-level block is lifted. On iOS this is
  // the signature of Lockdown Mode (which disables service workers and Web
  // Push); a content blocker or a disabled WebKit feature flag can do the same.
  if (!("serviceWorker" in navigator)) {
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
          To get notifications on iPhone or iPad, add Armada to your Home Screen: in Safari, tap
          the Share button, choose <strong>Add to Home Screen</strong>, then open Armada from the
          new icon.
        </p>
        <p className="text-xs text-muted-foreground">
          iOS only delivers notifications to apps installed on the Home Screen, not to sites open
          in a browser tab.
        </p>
      </div>
    );
  }
  return (
    <div className="space-y-2">
      <p className="text-sm text-muted-foreground">
        Notifications on iPhone and iPad need iOS 16.4 or later. If you recently updated Armada,
        remove it from your Home Screen and add it again so iOS re-registers it as an app, then
        reopen it from the new icon.
      </p>
      <p className="text-xs text-muted-foreground">
        If they still don&rsquo;t turn on after that, your iOS version doesn&rsquo;t support them
        yet.
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
  const { apiAvailable, permission, intent, setEnabled, prefs, setPrefs } =
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
        enabled={intent}
        busy={false}
        blocked={blocked}
        blockedMessage="Notifications are blocked in your browser settings."
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
  prefs: PushPrefs;
  onToggle: (value: boolean) => void;
  onSetPrefs: (next: PushPrefs) => void;
}) {
  const { title, description, enabled, busy, blocked, blockedMessage, prefs } = props;

  const setPref = (key: keyof PushPrefs) => (value: boolean) => {
    props.onSetPrefs({ ...prefs, [key]: value });
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
