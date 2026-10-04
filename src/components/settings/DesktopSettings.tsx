import { useEffect, useState } from "react";

import { SettingsRow } from "@/components/settings/SettingsSection";
import { Switch } from "@/components/ui/switch";
import {
  getDesktopLaunchSettings,
  setDesktopLaunchSettings,
  type DesktopLaunchSettings,
} from "@/lib/desktop";

/** Launch-at-login and start-minimized, via the Electron main process. Hides on shells without the bridge. */
export function DesktopSettings() {
  const [settings, setSettings] = useState<DesktopLaunchSettings | null>(null);
  const [loaded, setLoaded] = useState(false);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    let active = true;
    void getDesktopLaunchSettings().then((state) => {
      if (!active) return;
      setSettings(state);
      setLoaded(true);
    });
    return () => {
      active = false;
    };
  }, []);

  const apply = (next: { openAtLogin: boolean; openAsHidden: boolean }) => {
    setBusy(true);
    // Optimistic; the returned state is authoritative.
    setSettings((prev) => (prev ? { ...prev, ...next } : prev));
    void setDesktopLaunchSettings(next)
      .then((state) => {
        if (state) setSettings(state);
      })
      .finally(() => setBusy(false));
  };

  if (!loaded || !settings?.supported) return null;

  return (
    <>
      <SettingsRow
        label="Launch on startup"
        description="Start Armada automatically when you log in to this computer."
      >
        <Switch
          checked={settings.openAtLogin}
          disabled={busy}
          onCheckedChange={(openAtLogin) =>
            apply({ openAtLogin, openAsHidden: openAtLogin && settings.openAsHidden })
          }
        />
      </SettingsRow>
      {settings.openAtLogin && (
        <SettingsRow
          label="Start minimized"
          description="When launched at login, start hidden in the tray instead of opening the window."
          className="pl-8 motion-safe:animate-in motion-safe:fade-in-0 motion-safe:slide-in-from-top-2 motion-safe:duration-200"
        >
          <Switch
            checked={settings.openAsHidden}
            disabled={busy}
            onCheckedChange={(openAsHidden) => apply({ openAtLogin: true, openAsHidden })}
          />
        </SettingsRow>
      )}
    </>
  );
}

export default DesktopSettings;
