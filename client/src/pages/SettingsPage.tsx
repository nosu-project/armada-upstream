import {
  Anchor,
  ArrowLeft,
  Bell,
  ChevronDown,
  ChevronRight,
  MessageSquareLock,
  Mic,
  Palette,
  Search,
  Server,
  UserCircle,
  Waypoints,
  Wrench,
} from "lucide-react";
import { useState } from "react";
import { useNavigate } from "react-router-dom";

import { LoginArea } from "@/components/auth/LoginArea";
import { ConcordResyncCard } from "@/components/ConcordResyncCard";
import { ProfileSettings } from "@/components/ProfileSettings";
import { NotificationSettings } from "@/components/NotificationSettings";
import { RelayListEditor } from "@/components/RelayListEditor";
import { SettingsRow, SettingsSection } from "@/components/settings/SettingsSection";
import { ThemeSelector } from "@/components/ThemeSelector";
import { VoiceDeviceSettings } from "@/components/VoiceDeviceSettings";
import { Button } from "@/components/ui/button";
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "@/components/ui/collapsible";
import { Switch } from "@/components/ui/switch";
import { useAppContext } from "@/hooks/useAppContext";
import { useCurrentUser } from "@/hooks/useCurrentUser";
import { useDmRelayList } from "@/hooks/useDmRelayList";
import { useEncryptedSettings } from "@/hooks/useEncryptedSettings";
import { useUpdateUserGroupList } from "@/hooks/useUserGroupList";
import { CONCORD_ENABLED } from "@/lib/concord";
import { APP_RELAYS, PLATFORM_RELAYS, SEARCH_RELAYS } from "@/lib/platform";
import {
  getAudioProcessing,
  setAudioProcessing,
  type AudioProcessingPrefs,
} from "@/lib/voiceDevices";
import { rnnoiseSupported } from "@/lib/voiceProcessor";

import type { EncryptedSettings } from "@/lib/schemas";

/** App settings: account, theme, the server list, app relays, and search relays. */
export function SettingsPage() {
  const navigate = useNavigate();
  const { config, updateConfig } = useAppContext();
  const { user } = useCurrentUser();
  const { updateSettings, hasNip44Support } = useEncryptedSettings();
  const { mutateAsync: updateList } = useUpdateUserGroupList();
  const dmRelayList = useDmRelayList();

  // Voice mic-processing prefs are device-local (stored in localStorage, not
  // synced AppConfig — a setting right for a laptop mic is wrong on a phone).
  // Mirror the in-call gear menu; changes apply to the next captured mic track
  // (and live mid-call, since the gear menu restarts the track on change).
  const [voiceProcessing, setVoiceProcessing] = useState<AudioProcessingPrefs>(() =>
    getAudioProcessing(),
  );
  const [showAdvanced, setShowAdvanced] = useState(false);
  const setVoiceToggle = (key: keyof AudioProcessingPrefs) => (value: boolean) => {
    setVoiceProcessing((prev) => {
      const next = { ...prev, [key]: value };
      setAudioProcessing(next);
      return next;
    });
  };

  /**
   * Update a relay field locally and sync to encrypted settings when logged in.
   * The added-server list (`addedRelays`) is handled separately by
   * `setAddedRelays` (NIP-29 kind 10009), and the DM relays by `setDmRelays`
   * (also republishes the NIP-17 kind 10050 list).
   */
  const setRelays = (key: "appRelays" | "searchRelays") => (relays: string[]) => {
    updateConfig((current) => ({ ...current, [key]: relays }));
    if (hasNip44Support) {
      updateSettings({ [key]: relays } as Partial<EncryptedSettings>).catch((err) =>
        console.warn("Relay sync failed:", err));
    }
  };

  /**
   * Update the user's server list. The local cache updates immediately; the
   * change is diffed and persisted to the NIP-29 kind 10009 list (`r` tags),
   * the cross-device source of truth.
   */
  const setAddedRelays = (relays: string[]) => {
    const prev = config.addedRelays;
    updateConfig((current) => ({ ...current, addedRelays: relays }));
    if (!user) return;
    for (const url of relays) {
      if (!prev.includes(url)) {
        updateList({ type: "add-server", url }).catch((err) =>
          console.warn("Failed to add server to group list:", err));
      }
    }
    for (const url of prev) {
      if (!relays.includes(url)) {
        updateList({ type: "remove-server", url }).catch((err) =>
          console.warn("Failed to remove server from group list:", err));
      }
    }
  };

  /**
   * Persist the user's DM relays. Updates local config + encrypted settings
   * (cross-device), and — since kind 10050 is the canonical, discoverable
   * "where to send me DMs" list — republishes it so other clients stay in
   * sync. `publish: false` skips the republish when we just seeded the editor
   * from an already-published 10050 (no edit to write back).
   */
  const setDmRelays = (relays: string[], opts: { publish?: boolean } = {}) => {
    updateConfig((current) => ({ ...current, dmRelays: relays }));
    if (hasNip44Support) {
      updateSettings({ dmRelays: relays }).catch((err) =>
        console.warn("Relay sync failed:", err));
    }
    if (opts.publish !== false && user) {
      dmRelayList.publish(relays).catch((err) =>
        console.warn("DM relay list (kind 10050) publish failed:", err));
    }
  };

  /** Toggle whether DMs use the user's own relays; sync to encrypted settings. */
  const setUseOwnDmRelays = (value: boolean) => {
    updateConfig((current) => ({ ...current, useOwnDmRelays: value }));
    if (hasNip44Support) {
      updateSettings({ useOwnDmRelays: value }).catch((err) =>
        console.warn("DM relay setting sync failed:", err));
    }
    // On opt-in, seed from the user's published NIP-17 DM relay list (kind
    // 10050) if they have one, so the editor — and the relays DMs actually use
    // (effectiveDmRelays) — reflect their canonical, discoverable list rather
    // than the app-relay default.
    if (value) {
      dmRelayList.refetch().then((res) => {
        const fetched = res.data ?? [];
        if (fetched.length > 0) setDmRelays(fetched, { publish: false });
      });
    }
  };

  return (
    <main className="flex-1 min-w-0 flex flex-col safe-area-top">
      {/* Header — a detached floating command bar matching the group/Concord/DM
          chrome (cut-corner card, recessed shade), but capped to the settings
          content width and centered on desktop. */}
      <header className="relative h-12 touch:h-14 mx-2 mt-3 w-[calc(100%-1rem)] max-w-2xl sm:mx-auto px-2 sidebar:px-3 flex items-center gap-1.5 shrink-0 clip-corner-lg bg-chrome">
        <Button variant="ghost" size="icon" className="size-9 shrink-0" aria-label="Back" onClick={() => navigate(-1)}>
          <ArrowLeft className="size-5" />
        </Button>
        <h1 className="font-semibold truncate leading-tight">Settings</h1>
      </header>

      <div className="flex-1 min-h-0 overflow-y-auto safe-area-bottom">
        <div className="max-w-2xl mx-auto px-4 sm:px-6 pb-12">
          <div className="space-y-6 pt-4">
          <SettingsSection title="Account" icon={UserCircle}>
            <SettingsRow>
              <LoginArea className="w-full flex" />
            </SettingsRow>
          </SettingsSection>

          {user && (
            <SettingsSection title="Profile" icon={UserCircle}>
              <SettingsRow>
                <ProfileSettings />
              </SettingsRow>
            </SettingsSection>
          )}

          {user && (
            <SettingsSection title="Notifications" icon={Bell}>
              <SettingsRow>
                <NotificationSettings />
              </SettingsRow>
            </SettingsSection>
          )}

          <SettingsSection title="Appearance" icon={Palette}>
            <SettingsRow>
              <ThemeSelector />
            </SettingsRow>
          </SettingsSection>

          <SettingsSection title="Servers" icon={Server}>
            <SettingsRow>
              <RelayListEditor
                pinned={PLATFORM_RELAYS}
                relays={config.addedRelays}
                onChange={setAddedRelays}
                emptyText="No extra servers added. Use the + button in the server rail to add one."
                placeholder="wss://server.example.com"
              />
            </SettingsRow>
          </SettingsSection>

          <SettingsSection title="App relays" icon={Waypoints}>
            <SettingsRow>
              <RelayListEditor
                relays={config.appRelays}
                onChange={setRelays("appRelays")}
                onReset={() => setRelays("appRelays")([...APP_RELAYS])}
                emptyText="No app relays — profiles and lists are stored on your internal servers only."
              />
            </SettingsRow>
          </SettingsSection>

          <SettingsSection title="Search relays" icon={Search}>
            <SettingsRow>
              <RelayListEditor
                relays={config.searchRelays}
                onChange={setRelays("searchRelays")}
                onReset={() => setRelays("searchRelays")([...SEARCH_RELAYS])}
                emptyText="No search relays — search falls back to your app relays."
              />
            </SettingsRow>
          </SettingsSection>

          <SettingsSection title="Direct messages" icon={MessageSquareLock}>
            <SettingsRow
              label="Use my own DM relays"
              description="Store and read DMs on your own relays instead of the app relays."
            >
              <Switch checked={config.useOwnDmRelays} onCheckedChange={setUseOwnDmRelays} />
            </SettingsRow>
            {config.useOwnDmRelays && (
              <SettingsRow>
                <RelayListEditor
                  relays={config.dmRelays}
                  onChange={setDmRelays}
                  onReset={() => setDmRelays([...APP_RELAYS])}
                  emptyText="No DM relays — add at least one, or DMs fall back to your app relays."
                  placeholder="wss://dm-relay.example.com"
                />
              </SettingsRow>
            )}
          </SettingsSection>

          <SettingsSection title="Voice" icon={Mic}>
            <SettingsRow>
              <VoiceDeviceSettings />
            </SettingsRow>
            {rnnoiseSupported() && (
              <SettingsRow
                label="Noise cancellation"
                description="ML background-noise removal (RNNoise) — removes keyboards, fans, and chatter. Applied to your next call."
              >
                <Switch
                  checked={voiceProcessing.rnnoise}
                  onCheckedChange={setVoiceToggle("rnnoise")}
                />
              </SettingsRow>
            )}
            <SettingsRow
              label="Noise suppression"
              description="Filter out background hum and keyboard noise."
            >
              <Switch
                checked={voiceProcessing.noiseSuppression}
                onCheckedChange={setVoiceToggle("noiseSuppression")}
              />
            </SettingsRow>
            <SettingsRow
              label="Echo cancellation"
              description="Stop your speakers from echoing back into the mic."
            >
              <Switch
                checked={voiceProcessing.echoCancellation}
                onCheckedChange={setVoiceToggle("echoCancellation")}
              />
            </SettingsRow>
            <SettingsRow
              label="Auto gain control"
              description="Even out your volume automatically."
            >
              <Switch
                checked={voiceProcessing.autoGainControl}
                onCheckedChange={setVoiceToggle("autoGainControl")}
              />
            </SettingsRow>
          </SettingsSection>

          {user && CONCORD_ENABLED && (
            <SettingsSection title="Advanced" icon={Wrench}>
              <Collapsible open={showAdvanced} onOpenChange={setShowAdvanced}>
                <CollapsibleTrigger asChild>
                  <button
                    type="button"
                    className="flex w-full items-center gap-3 px-4 py-3 text-left transition-colors hover:bg-accent/40"
                    aria-expanded={showAdvanced}
                  >
                    <div className="min-w-0 flex-1 space-y-0.5">
                      <div className="text-sm font-medium leading-tight">Recover communities</div>
                      <div className="text-xs text-muted-foreground leading-snug">
                        Find and restore encrypted rooms missing from your list.
                      </div>
                    </div>
                    <ChevronDown
                      className="size-4 text-muted-foreground shrink-0 transition-transform duration-200 [[data-state=open]_&]:rotate-180"
                    />
                  </button>
                </CollapsibleTrigger>
                <CollapsibleContent>
                  <div className="border-t border-chrome px-4 py-3.5">
                    <ConcordResyncCard />
                  </div>
                </CollapsibleContent>
              </Collapsible>
            </SettingsSection>
          )}

          <SettingsSection title="About" icon={Anchor}>
            <SettingsRow
              label="How Armada works"
              description="The two ways to talk, and what stays private."
              onClick={() => navigate("/about")}
            >
              <ChevronRight className="size-4 text-muted-foreground" />
            </SettingsRow>
          </SettingsSection>
          </div>
        </div>
      </div>
    </main>
  );
}
