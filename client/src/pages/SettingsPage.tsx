import { ArrowLeft, Plus, RotateCcw, Trash2 } from "lucide-react";
import { useState } from "react";
import { useNavigate } from "react-router-dom";

import { LoginArea } from "@/components/auth/LoginArea";
import { ThemeSelector } from "@/components/ThemeSelector";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { useAppContext } from "@/hooks/useAppContext";
import { toast } from "@/hooks/useToast";
import { APP_NAME, APP_RELAYS, normalizeRelayUrl, PLATFORM_RELAYS } from "@/lib/platform";

/** App settings: account, theme, the server list, and app relays. */
export function SettingsPage() {
  const navigate = useNavigate();
  const { config, updateConfig } = useAppContext();
  const [newAppRelay, setNewAppRelay] = useState("");

  const handleAddAppRelay = () => {
    const normalized = normalizeRelayUrl(newAppRelay);
    if (!normalized) {
      toast({ title: "Invalid relay URL", description: "Enter a ws:// or wss:// URL.", variant: "destructive" });
      return;
    }
    if (config.appRelays.includes(normalized)) {
      toast({ title: "Already in the list", description: normalized });
      return;
    }
    updateConfig((current) => ({ ...current, appRelays: [...current.appRelays, normalized] }));
    setNewAppRelay("");
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
          <CardContent className="space-y-2">
            {PLATFORM_RELAYS.map((url) => (
              <div key={url} className="flex items-center gap-2 rounded-lg border p-3">
                <span className="text-sm font-mono break-all flex-1">{url}</span>
                <span className="text-xs text-muted-foreground shrink-0">Pinned</span>
              </div>
            ))}
            {config.addedRelays.map((url) => (
              <div key={url} className="flex items-center gap-2 rounded-lg border p-3">
                <span className="text-sm font-mono break-all flex-1">{url}</span>
                <Button
                  variant="ghost"
                  size="icon"
                  aria-label={`Remove ${url}`}
                  className="size-7 text-muted-foreground hover:text-destructive shrink-0"
                  onClick={() =>
                    updateConfig((current) => ({
                      ...current,
                      addedRelays: current.addedRelays.filter((u) => u !== url),
                    }))}
                >
                  <Trash2 className="size-4" />
                </Button>
              </div>
            ))}
            {config.addedRelays.length === 0 && (
              <p className="text-sm text-muted-foreground">
                No extra servers added. Use the + button in the server rail to add one.
              </p>
            )}
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
          <CardContent className="space-y-2">
            {config.appRelays.map((url) => (
              <div key={url} className="flex items-center gap-2 rounded-lg border p-3">
                <span className="text-sm font-mono break-all flex-1">{url}</span>
                <Button
                  variant="ghost"
                  size="icon"
                  aria-label={`Remove ${url}`}
                  className="size-7 text-muted-foreground hover:text-destructive shrink-0"
                  onClick={() =>
                    updateConfig((current) => ({
                      ...current,
                      appRelays: current.appRelays.filter((u) => u !== url),
                    }))}
                >
                  <Trash2 className="size-4" />
                </Button>
              </div>
            ))}
            {config.appRelays.length === 0 && (
              <p className="text-sm text-muted-foreground">
                No app relays — profiles and lists are stored on your internal servers only.
              </p>
            )}

            <form
              className="flex gap-2 pt-1"
              onSubmit={(e) => {
                e.preventDefault();
                handleAddAppRelay();
              }}
            >
              <Input
                value={newAppRelay}
                onChange={(e) => setNewAppRelay(e.target.value)}
                placeholder="wss://relay.example.com"
                aria-label="Add app relay"
                autoComplete="off"
              />
              <Button type="submit" variant="outline" disabled={!newAppRelay.trim()}>
                <Plus className="size-4 mr-1.5" /> Add
              </Button>
            </form>

            <Button
              type="button"
              variant="ghost"
              size="sm"
              className="text-muted-foreground"
              onClick={() =>
                updateConfig((current) => ({ ...current, appRelays: [...APP_RELAYS] }))}
            >
              <RotateCcw className="size-3.5 mr-1.5" /> Reset to defaults
            </Button>
          </CardContent>
        </Card>
      </div>
    </main>
  );
}
