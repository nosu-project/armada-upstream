import { Capacitor } from "@capacitor/core";

import { QuickReactionsSettings } from "@/components/settings/QuickReactionsSettings";
import { SettingsGroup, SettingsRow } from "@/components/settings/SettingsSection";
import { Switch } from "@/components/ui/switch";
import { useAppContext } from "@/hooks/useAppContext";
import { useCurrentUser } from "@/hooks/useCurrentUser";
import { useIsTouch } from "@/hooks/useIsMobile";
import { sendsOnEnter } from "@/lib/sendOnEnter";

/** Settings › Chats: composing, typing status and reactions, everywhere you chat. */
export function ChatSettings() {
  const { config, updateConfig } = useAppContext();
  const { user } = useCurrentUser();
  const isTouch = useIsTouch();

  /** Toggle send-on-Enter, stored per device class — see AppConfig.sendOnEnter. */
  const setSendOnEnter = (value: boolean) => {
    const key = isTouch ? "touch" : "desktop";
    updateConfig((current) => ({
      ...current,
      sendOnEnter: { ...current.sendOnEnter, [key]: value },
    }));
  };

  return (
    <>
      <SettingsGroup id="chat">
        <SettingsRow
          label="Send with Enter"
          description={
            isTouch
              ? "Enter sends the message. Off, Enter is a new line and you send with the button."
              : "Enter sends; Shift+Enter for a new line. Off, Ctrl/Cmd+Enter sends."
          }
        >
          <Switch
            checked={sendsOnEnter(config.sendOnEnter, isTouch)}
            onCheckedChange={setSendOnEnter}
          />
        </SettingsRow>
        <SettingsRow
          label="Typing indicators"
          description="Share and see typing status in DMs and channels."
        >
          <Switch
            checked={config.dmTypingIndicators}
            onCheckedChange={(dmTypingIndicators) =>
              updateConfig((current) => ({ ...current, dmTypingIndicators }))}
          />
        </SettingsRow>
        {!isTouch && (
          <SettingsRow
            label="Message actions on hover"
            description="Show reactions and actions when hovering a message. Off, right-click a message for them."
          >
            <Switch
              checked={config.messageHoverActions}
              onCheckedChange={(messageHoverActions) =>
                updateConfig((current) => ({ ...current, messageHoverActions }))}
            />
          </SettingsRow>
        )}
        {Capacitor.getPlatform() === "android" && (
          // Per-device: leave the app vs. walk history from the revealed list pane.
          <SettingsRow
            label="Back leaves the app"
            description="Off, back switches between the channel list and the chat."
          >
            <Switch
              checked={config.androidBackLeavesApp}
              onCheckedChange={(androidBackLeavesApp) =>
                updateConfig((current) => ({ ...current, androidBackLeavesApp }))}
            />
          </SettingsRow>
        )}
      </SettingsGroup>

      {user && (
        <SettingsGroup id="quick-reactions">
          <QuickReactionsSettings />
        </SettingsGroup>
      )}
    </>
  );
}
