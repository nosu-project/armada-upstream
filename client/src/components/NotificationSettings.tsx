import { useCurrentUser } from "@/hooks/useCurrentUser";
import { useNativeNotifications } from "@/hooks/useNativeNotifications";
import { usePushNotifications, type PushPrefs } from "@/hooks/usePushNotifications";

import { Switch } from "@/components/ui/switch";

/**
 * Notification settings.
 *
 * Two delivery paths, picked by runtime:
 *  - Native APK: a foreground service holds a persistent relay connection and
 *    fires local notifications instantly (no FCM/Google). See
 *    useNativeNotifications.
 *  - Web / PWA: Web Push via the Armada relay's VAPID gateway. See
 *    usePushNotifications.
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
    );
  }

  return <WebPushSettings />;
}

function WebPushSettings() {
  const { supported, permission, enabled, busy, prefs, enable, disable, setPrefs } =
    usePushNotifications();

  if (!supported) {
    return (
      <p className="text-sm text-muted-foreground">
        Web Push isn't available in this browser. On iOS, add Armada to your Home Screen first.
      </p>
    );
  }

  return (
    <NotificationToggles
      title="Enable push notifications"
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
