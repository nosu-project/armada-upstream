import { ArrowLeft, Trash2 } from "lucide-react";
import { useNavigate } from "react-router-dom";

import { LoginArea } from "@/components/auth/LoginArea";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { useAppContext } from "@/hooks/useAppContext";
import { APP_NAME, PLATFORM_RELAYS } from "@/lib/platform";

import type { Theme } from "@/contexts/AppContext";

/** App settings: account, theme, and the server list. */
export function SettingsPage() {
  const navigate = useNavigate();
  const { config, updateConfig } = useAppContext();

  return (
    <main className="flex-1 min-w-0 overflow-y-auto">
      <div className="max-w-2xl mx-auto p-8 space-y-6">
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
          </CardHeader>
          <CardContent>
            <div className="flex items-center justify-between">
              <Label htmlFor="theme-select">Theme</Label>
              <Select
                value={config.theme}
                onValueChange={(value) =>
                  updateConfig((current) => ({ ...current, theme: value as Theme }))}
              >
                <SelectTrigger id="theme-select" className="w-40">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="dark">Dark</SelectItem>
                  <SelectItem value="light">Light</SelectItem>
                  <SelectItem value="system">System</SelectItem>
                </SelectContent>
              </Select>
            </div>
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
      </div>
    </main>
  );
}
