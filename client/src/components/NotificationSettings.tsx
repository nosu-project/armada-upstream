import { useCurrentUser } from "@/hooks/useCurrentUser";
import { usePushNotifications, type PushPrefs } from "@/hooks/usePushNotifications";

import { Switch } from "@/components/ui/switch";

/**
 * Notification settings: a master Web Push toggle plus Discord-style per-type
 * switches. Push is delivered by the Armada relay itself (it sees every
 * message), so no external service is involved.
 */
export function NotificationSettings() {
  const { user } = useCurrentUser();
  const { supported, permission, enabled, busy, prefs, enable, disable, setPrefs } =
    usePushNotifications();

  if (!user) {
    return <p className="text-sm text-muted-foreground">Log in to enable notifications.</p>;
  }

  if (!supported) {
    return (
      <p className="text-sm text-muted-foreground">
        Web Push isn't available in this browser. On iOS, add Armada to your Home Screen first.
      </p>
    );
  }

  const blocked = permission === "denied";

  const toggleMaster = async (value: boolean) => {
    if (value) await enable();
    else await disable();
  };

  const setPref = (key: keyof PushPrefs) => (value: boolean) => {
    setPrefs({ ...prefs, [key]: value }).catch(() => {});
  };

  return (
    <div className="space-y-5">
      <label className="flex items-center justify-between gap-4 cursor-pointer">
        <span className="text-sm font-medium">
          Enable push notifications
          {blocked && (
            <span className="block text-xs font-normal text-destructive">
              Notifications are blocked in your browser settings.
            </span>
          )}
        </span>
        <Switch
          checked={enabled}
          disabled={busy || blocked}
          onCheckedChange={toggleMaster}
        />
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
