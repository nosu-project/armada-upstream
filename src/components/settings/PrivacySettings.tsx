import { AlertTriangle, LifeBuoy, SpellCheck, UserX } from "lucide-react";
import { useContext } from "react";

import { MediaPrivacySettings } from "@/components/settings/MediaPrivacySettings";
import { SettingsGroup, SettingsRow } from "@/components/settings/SettingsSection";
import { SettingsNavContext } from "@/components/settings/settingsNav";
import { Switch } from "@/components/ui/switch";
import { useAppContext } from "@/hooks/useAppContext";
import { useCurrentUser } from "@/hooks/useCurrentUser";
import { useMutedPubkeys } from "@/hooks/useMuteList";

/** Settings › Privacy & safety: who and what is hidden, what loads without asking, and links. */
export function PrivacySettings() {
  const { config, updateConfig } = useAppContext();
  const { user } = useCurrentUser();
  const nav = useContext(SettingsNavContext);
  const { mutedPubkeys, ready } = useMutedPubkeys();

  return (
    <>
      {user && (
        <SettingsGroup
          title="Blocking"
          footer="Blocked people and muted words are hidden everywhere in Armada. Only you see these lists, and nobody is told."
        >
          {/* The only place to unblock: blocked people appear in no other list. */}
          <SettingsRow
            icon={UserX}
            tone="destructive"
            label="Blocked people"
            value={ready ? (mutedPubkeys.size || "None") : undefined}
            chevron
            onClick={() => nav.open("blocked")}
          />
          <SettingsRow
            icon={SpellCheck}
            tone="warning"
            label="Muted words"
            value={config.mutedWords.length || "None"}
            chevron
            onClick={() => nav.open("muted-words")}
          />
        </SettingsGroup>
      )}

      <SettingsGroup id="media" title="Media">
        <MediaPrivacySettings />
      </SettingsGroup>

      <SettingsGroup id="links" title="Links">
        <SettingsRow
          label="Clean up links"
          description="Strip tracking parameters like utm_ and ?si= from links."
        >
          <Switch
            checked={config.stripTrackingParams}
            onCheckedChange={(stripTrackingParams) =>
              updateConfig((current) => ({ ...current, stripTrackingParams }))}
          />
        </SettingsRow>
      </SettingsGroup>

      <SettingsGroup id="discover" title="Discover">
        {/* Bypasses Discover's curated allow-list (a foot-gun). */}
        <SettingsRow
          label="Show all content"
          description={
            <>
              Show everything posted to your relays, not just curated picks and
              people you follow.
              {config.discoverAllContent && (
                <span className="mt-1 flex items-start gap-1.5 text-destructive">
                  <AlertTriangle className="mt-0.5 size-3.5 shrink-0" />
                  <span>Unmoderated. Expect spam and offensive content.</span>
                </span>
              )}
            </>
          }
        >
          <Switch
            checked={config.discoverAllContent}
            onCheckedChange={(discoverAllContent) =>
              updateConfig((current) => ({ ...current, discoverAllContent }))}
          />
        </SettingsRow>
      </SettingsGroup>

      <SettingsGroup>
        <SettingsRow
          icon={LifeBuoy}
          tone="success"
          label="Help & safety"
          description="Blocking, hiding, muted words, reporting and getting help."
          to="/support"
        />
      </SettingsGroup>
    </>
  );
}
