import { Waypoints } from "lucide-react";
import { useContext } from "react";

import { SettingsGroup, SettingsRow } from "@/components/settings/SettingsSection";
import { SettingsNavContext } from "@/components/settings/settingsNav";
import { Switch } from "@/components/ui/switch";
import { useAppContext } from "@/hooks/useAppContext";

/** Settings › Direct messages. */
export function DirectMessageSettings() {
  const { config, updateConfig } = useAppContext();
  const nav = useContext(SettingsNavContext);
  const dmRelayCount = config.dmRelays.length;

  return (
    <>
      <SettingsGroup id="dms">
        {/* Empties every DM subscription's relay set; deletes no conversations and keeps the 10050. */}
        <SettingsRow
          label="Turn off direct messages"
          description="Stop receiving DMs on all your devices. Existing conversations are kept."
        >
          <Switch
            checked={config.dmsDisabled}
            onCheckedChange={(dmsDisabled) => updateConfig((current) => ({ ...current, dmsDisabled }))}
          />
        </SettingsRow>
      </SettingsGroup>

      {/* With DMs disabled, only the master toggle remains. */}
      {!config.dmsDisabled && (
        <>
          <SettingsGroup title="Inbox">
            {/* Display only: hiding the request tier drops no messages. */}
            <SettingsRow
              label="Message requests"
              description="Show DMs from strangers under Requests. Off hides them."
            >
              <Switch
                checked={config.showDmRequests}
                onCheckedChange={(showDmRequests) => updateConfig((current) => ({ ...current, showDmRequests }))}
              />
            </SettingsRow>
            <SettingsRow
              label="Message previews"
              description="Show the latest message under each conversation in your DM list."
            >
              <Switch
                checked={config.showDmPreviews}
                onCheckedChange={(showDmPreviews) => updateConfig((current) => ({ ...current, showDmPreviews }))}
              />
            </SettingsRow>
            <SettingsRow
              label="Recent DMs in the rail"
              description="Show unread DMs at the top of the server rail."
            >
              <Switch
                checked={config.showRecentRailDms}
                onCheckedChange={(showRecentRailDms) => updateConfig((current) => ({ ...current, showRecentRailDms }))}
              />
            </SettingsRow>
          </SettingsGroup>

          <SettingsGroup footer="Where messages from other Nostr apps arrive.">
            <SettingsRow
              icon={Waypoints}
              tone="accent2"
              label="Message relays"
              value={dmRelayCount || "None"}
              chevron
              onClick={() => nav.open("relays")}
            />
          </SettingsGroup>
        </>
      )}
    </>
  );
}
