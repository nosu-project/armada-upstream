import { useEffect, useState } from 'react';
import { Capacitor } from '@capacitor/core';
import type { AppInfo } from 'capacitor-plugin-nostr-signer';
import { Loader2 } from 'lucide-react';

import { AndroidNativeSigner } from '@/lib/androidNativeSigner';
import { useLoginActions } from '@/hooks/useLoginActions';
import { Alert, AlertDescription } from '@/components/ui/alert';

interface AndroidSignerOptionsProps {
  onLogin: () => void;
}

// NIP-55 signer apps installed on the device. Renders null off Capacitor Android.
export function AndroidSignerOptions({ onLogin }: AndroidSignerOptionsProps) {
  const isAndroidNative =
    Capacitor.isNativePlatform() && Capacitor.getPlatform() === 'android';

  const [apps, setApps] = useState<AppInfo[] | null>(null);
  const [connectingPkg, setConnectingPkg] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const login = useLoginActions();

  useEffect(() => {
    if (!isAndroidNative) return;
    let cancelled = false;

    AndroidNativeSigner.getSignerApps()
      .then((list) => { if (!cancelled) setApps(list); })
      .catch((e) => {
        if (cancelled) return;
        // Throws when no signer is installed; treat that as "no apps".
        console.warn('Failed to enumerate Android signer apps:', e);
        setApps([]);
      });

    return () => { cancelled = true; };
  }, [isAndroidNative]);

  if (!isAndroidNative) return null;
  if (apps === null) return null; // initial probe — render nothing rather than flashing a spinner
  if (apps.length === 0) return null;

  const handleConnect = async (app: AppInfo) => {
    setError(null);
    setConnectingPkg(app.packageName);
    try {
      await login.androidSigner(app.packageName);
      onLogin();
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      setError(msg);
    } finally {
      setConnectingPkg(null);
    }
  };

  return (
    <div className="space-y-3">
      {error && (
        <Alert variant="destructive">
          <AlertDescription>{error}</AlertDescription>
        </Alert>
      )}
      <div className="space-y-2">
        {apps.map((app) => {
          const connecting = connectingPkg === app.packageName;
          return (
            <button
              key={app.packageName}
              type="button"
              onClick={() => handleConnect(app)}
              disabled={connectingPkg !== null}
              className="w-full flex items-center gap-3 clip-corner-lg bg-background/40 px-4 py-3 text-left transition-colors hover:bg-muted disabled:opacity-60 disabled:cursor-not-allowed"
            >
              {app.iconUrl ? (
                <img
                  src={app.iconUrl}
                  alt=""
                  className="w-8 h-8 flex-shrink-0"
                />
              ) : (
                <div className="w-8 h-8 bg-muted flex-shrink-0" />
              )}
              <div className="flex-1 min-w-0">
                <div className="font-medium text-sm truncate">
                  {connecting ? 'Connecting…' : `Log in with ${app.name}`}
                </div>
                <div className="text-xs text-muted-foreground truncate">
                  Use the {app.name} app on your device.
                </div>
              </div>
              {connecting && (
                <Loader2 className="w-4 h-4 animate-spin text-muted-foreground flex-shrink-0" />
              )}
            </button>
          );
        })}
      </div>
    </div>
  );
}
