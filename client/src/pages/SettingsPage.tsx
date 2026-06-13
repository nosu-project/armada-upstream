import { ArrowLeft } from "lucide-react";
import { useNavigate } from "react-router-dom";

import { LoginArea } from "@/components/auth/LoginArea";
import { RelayListEditor } from "@/components/RelayListEditor";
import { ThemeSelector } from "@/components/ThemeSelector";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { useAppContext } from "@/hooks/useAppContext";
import { useEncryptedSettings } from "@/hooks/useEncryptedSettings";
import { APP_NAME, APP_RELAYS, PLATFORM_RELAYS, SEARCH_RELAYS } from "@/lib/platform";

import type { EncryptedSettings } from "@/lib/schemas";

/** App settings: account, theme, the server list, app relays, and search relays. */
export function SettingsPage() {
  const navigate = useNavigate();
  const { config, updateConfig } = useAppContext();
  const { updateSettings, hasNip44Support } = useEncryptedSettings();

  /** Update a relay field locally and sync to encrypted settings when logged in. */
  const setRelays = (key: "addedRelays" | "appRelays" | "searchRelays") => (relays: string[]) => {
    updateConfig((current) => ({ ...current, [key]: relays }));
    if (hasNip44Support) {
      updateSettings({ [key]: relays } as Partial<EncryptedSettings>).catch((err) =>
        console.warn("Relay sync failed:", err));
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
              yourself can be removed here.
            </CardDescription>
          </CardHeader>
          <CardContent>
            <RelayListEditor
              pinned={PLATFORM_RELAYS}
              relays={config.addedRelays}
              onChange={setRelays("addedRelays")}
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
      </div>
    </main>
  );
}
