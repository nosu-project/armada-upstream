import { useEffect, useState } from "react";

import { SettingsRow } from "@/components/settings/SettingsSection";
import { Switch } from "@/components/ui/switch";
import {
  getDesktopLaunchSettings,
  setDesktopLaunchSettings,
  type DesktopLaunchSettings,
} from "@/lib/desktop";

/**
 * Desktop-shell behavior: launch Armada when you log in, and whether that
 * launch starts minimized to the tray. Both round-trip to the Electron main
 * process (the OS holds the login-item registration); rendered only inside the
 * desktop app, and self-hides when the running shell predates the bridge.
 */
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
    // Reflect the intent immediately; the returned state is authoritative.
    setSettings((prev) => (prev ? { ...prev, ...next } : prev));
    void setDesktopLaunchSettings(next)
      .then((state) => {
        if (state) setSettings(state);
      })
      .finally(() => setBusy(false));
  };

  // An older shell (no bridge) or an unsupported OS: nothing to configure.
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
            apply({ openAtLogin, openAsHidden: settings.openAsHidden })
          }
        />
      </SettingsRow>
      <SettingsRow
        label="Start minimized"
        description="When launched at login, start hidden in the tray instead of opening the window."
      >
        <Switch
          checked={settings.openAsHidden}
          disabled={busy || !settings.openAtLogin}
          onCheckedChange={(openAsHidden) =>
            apply({ openAtLogin: settings.openAtLogin, openAsHidden })
          }
        />
      </SettingsRow>
    </>
  );
}

export default DesktopSettings;
