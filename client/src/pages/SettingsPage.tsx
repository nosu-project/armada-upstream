import { ArrowLeft } from "lucide-react";
import { useState } from "react";
import { useNavigate } from "react-router-dom";

import { LoginArea } from "@/components/auth/LoginArea";
import { ProfileSettings } from "@/components/ProfileSettings";
import { NotificationSettings } from "@/components/NotificationSettings";
import { RelayListEditor } from "@/components/RelayListEditor";
import { ThemeSelector } from "@/components/ThemeSelector";
import { VoiceDeviceSettings } from "@/components/VoiceDeviceSettings";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Switch } from "@/components/ui/switch";
import { useAppContext } from "@/hooks/useAppContext";
import { useCurrentUser } from "@/hooks/useCurrentUser";
import { useDmRelayList } from "@/hooks/useDmRelayList";
import { useEncryptedSettings } from "@/hooks/useEncryptedSettings";
import { useUpdateUserGroupList } from "@/hooks/useUserGroupList";
import { APP_NAME, APP_RELAYS, PLATFORM_RELAYS, SEARCH_RELAYS } from "@/lib/platform";
import {
  getAudioProcessing,
  setAudioProcessing,
  type AudioProcessingPrefs,
} from "@/lib/voiceDevices";

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
    <main className="flex-1 min-w-0 overflow-y-auto">
      <div className="max-w-2xl mx-auto p-4 sm:p-8 space-y-6 safe-area-top safe-area-bottom">
        <div className="flex items-center gap-3">
          <Button variant="ghost" size="icon" aria-label="Back" onClick={() => navigate(-1)}>
            <ArrowLeft className="size-5" />
          </Button>
          <h1 className="text-2xl font-bold">Settings</h1>
        </div>

        <Card>
          <CardHeader>
            <CardTitle>Account</CardTitle>
            <CardDescription>Log in, switch accounts, or sign up with a new key.</CardDescription>
          </CardHeader>
          <CardContent>
            <LoginArea className="w-full flex" />
          </CardContent>
        </Card>

        {user && (
          <Card>
            <CardHeader>
              <CardTitle>Profile</CardTitle>
              <CardDescription>
                Customize how others see you: name, bio, avatar, banner, and custom fields.
                Changes publish to your Nostr profile (kind 0).
              </CardDescription>
            </CardHeader>
            <CardContent>
              <ProfileSettings />
            </CardContent>
          </Card>
        )}

        {user && (
          <Card>
            <CardHeader>
              <CardTitle>Notifications</CardTitle>
              <CardDescription>
                Get push notifications for messages, mentions, replies, reactions, and DMs —
                even when {APP_NAME} is closed. Delivered straight from your relay; no
                third-party push service.
              </CardDescription>
            </CardHeader>
            <CardContent>
              <NotificationSettings />
            </CardContent>
          </Card>
        )}

        <Card>
          <CardHeader>
            <CardTitle>Appearance</CardTitle>
            <CardDescription>
              Pick a base mode, a named theme, or build your own from three colors.
            </CardDescription>
          </CardHeader>
          <CardContent>
            <ThemeSelector />
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle>Servers</CardTitle>
            <CardDescription>
              {APP_NAME} is pinned to your internal platform relays. Servers you add
              yourself sync across your devices via your NIP-29 group list and can be
              removed here.
            </CardDescription>
          </CardHeader>
          <CardContent>
            <RelayListEditor
              pinned={PLATFORM_RELAYS}
              relays={config.addedRelays}
              onChange={setAddedRelays}
              emptyText="No extra servers added. Use the + button in the server rail to add one."
              placeholder="wss://server.example.com"
            />
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle>App relays</CardTitle>
            <CardDescription>
              General-purpose relays for everything that isn't channel traffic — profiles
              (kind 0), your group list (kind 10009), and other plain Nostr events. Channel
              messages always stay on their host server. Remove all of these for a fully
              internal deployment.
            </CardDescription>
          </CardHeader>
          <CardContent>
            <RelayListEditor
              relays={config.appRelays}
              onChange={setRelays("appRelays")}
              onReset={() => setRelays("appRelays")([...APP_RELAYS])}
              emptyText="No app relays — profiles and lists are stored on your internal servers only."
            />
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle>Search relays</CardTitle>
            <CardDescription>
              Relays used for full-text search (NIP-50) — profile and mention autocomplete.
              Search queries route only to these, not to every server. When empty, search
              falls back to your app relays. Look for the NIP-50 badge to confirm a relay
              supports search.
            </CardDescription>
          </CardHeader>
          <CardContent>
            <RelayListEditor
              relays={config.searchRelays}
              onChange={setRelays("searchRelays")}
              onReset={() => setRelays("searchRelays")([...SEARCH_RELAYS])}
              emptyText="No search relays — search falls back to your app relays."
            />
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle>Direct messages</CardTitle>
            <CardDescription>
              Direct messages use your app relays by default. Turn this on to store and read
              DMs on your own relays instead — seeded from your published DM relay list
              (kind 10050) when you have one, and republished there as you edit so other
              clients know where to reach you.
            </CardDescription>
          </CardHeader>
          <CardContent className="space-y-4">
            <label className="flex items-center justify-between gap-4 cursor-pointer">
              <span className="text-sm font-medium">Use my own DM relays</span>
              <Switch checked={config.useOwnDmRelays} onCheckedChange={setUseOwnDmRelays} />
            </label>
            {config.useOwnDmRelays && (
              <RelayListEditor
                relays={config.dmRelays}
                onChange={setDmRelays}
                onReset={() => setDmRelays([...APP_RELAYS])}
                emptyText="No DM relays — add at least one, or DMs fall back to your app relays."
                placeholder="wss://dm-relay.example.com"
              />
            )}
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle>Voice</CardTitle>
            <CardDescription>
              Choose and test your microphone and speaker, and set the mic processing
              applied to your captured audio in calls. These are device-local (they don't
              sync across your devices) and can also be changed from the gear menu while in
              a call.
            </CardDescription>
          </CardHeader>
          <CardContent className="space-y-6">
            <VoiceDeviceSettings />
            <div className="space-y-4">
              <h3 className="text-sm font-semibold text-muted-foreground">Microphone processing</h3>
              <label className="flex items-center justify-between gap-4 cursor-pointer">
                <span className="text-sm font-medium">Noise suppression</span>
                <Switch
                  checked={voiceProcessing.noiseSuppression}
                  onCheckedChange={setVoiceToggle("noiseSuppression")}
                />
              </label>
              <label className="flex items-center justify-between gap-4 cursor-pointer">
                <span className="text-sm font-medium">Echo cancellation</span>
                <Switch
                  checked={voiceProcessing.echoCancellation}
                  onCheckedChange={setVoiceToggle("echoCancellation")}
                />
              </label>
              <label className="flex items-center justify-between gap-4 cursor-pointer">
                <span className="text-sm font-medium">Auto gain control</span>
                <Switch
                  checked={voiceProcessing.autoGainControl}
                  onCheckedChange={setVoiceToggle("autoGainControl")}
                />
              </label>
            </div>
          </CardContent>
        </Card>
      </div>
    </main>
  );
}
