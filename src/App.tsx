// NOTE: This file should normally not be modified unless you are adding a new provider.
// To add new routes, edit the AppRouter.tsx file.

import { App as CapacitorApp } from "@capacitor/app";
import { Capacitor } from "@capacitor/core";
import { NostrLoginProvider } from "@nostrify/react/login";
import { focusManager, QueryClient, QueryClientProvider } from "@tanstack/react-query";

import { ensureAndroidBackListener } from "@/hooks/useAndroidBack";
import { AppProvider } from "@/components/AppProvider";
import { ArmadaDBProvider } from "@/components/ArmadaDBProvider";
import { DBMigrationGate } from "@/components/DBMigrationGate";
import { ControlPlaneSync } from "@/components/ControlPlaneSync";
import { DeepLinkWarmup } from "@/components/DeepLinkWarmup";
import { DesktopBadge } from "@/components/DesktopBadge";
import { MeshProvider } from "@/components/MeshProvider";
import { NativeNotifications } from "@/components/NativeNotifications";
import { NativeReadDismiss, NativeReadMarkerSync } from "@/components/NativeReadMarkerSync";
import NostrProvider from "@/components/NostrProvider";
import { NostrSync } from "@/components/NostrSync";
import { LoginSetup } from "@/components/onboarding/LoginSetup";
import { PlausibleProvider } from "@/components/PlausibleProvider";
import { PublishOutbox } from "@/components/PublishOutbox";
import { ReadStateProvider } from "@/components/ReadStateProvider";
import { ScreenSharePicker } from "@/components/ScreenSharePicker";
import { SyncGate } from "@/components/SyncGate";
import { TooltipProvider } from "@/components/ui/tooltip";
import WalletProvider from "@/components/WalletProvider";
import { WebPushNotifications } from "@/components/WebPushNotifications";
import { WireSync } from "@/wire/WireSync";
import { prewarmAuthorCache } from "@/lib/authorCache";
import { secureStorage } from "@/lib/secureStorage";

import AppRouter from "./AppRouter";

const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      refetchOnWindowFocus: false,
      staleTime: 60000, // 1 minute
      gcTime: 300000, // 5 minutes
      // Most queries in this app read ArmadaDB, not a network — and the default
      // `networkMode: "online"` PAUSES a query whenever `navigator.onLine` is
      // false, holding it at `status: "pending"` (`fetchStatus: "paused"`) for
      // as long as the browser says it's offline. Every skeleton gate in the app
      // is a `isPending` read, so that default hangs a loading skeleton over
      // data already on disk — indefinitely, not for a timeout. `navigator.onLine`
      // is also unreliable in an Android WebView, and Armada has a genuinely
      // offline mode (mesh) where local reads must still work.
      //
      // Relay-bound queries lose react-query's auto-resume-on-reconnect by this,
      // which they didn't rely on: each is individually timeout-bounded and has
      // its own refetch interval or sweep to catch up on.
      networkMode: "always",
    },
  },
});

// One bulk read of every cached kind-0, seeded into the `['author', pk]`
// cache at module load — before boot sync starts writing into the `main`
// tenant and starves individual reads. Names and avatars then paint from
// disk the moment their rows mount. See `prewarmAuthorCache`.
void prewarmAuthorCache(queryClient);

// On Android the WebView's `visibilitychange`/`focus` events (which React
// Query's focusManager watches by default) don't fire reliably when the app is
// brought back from the background — so a query that should refetch on focus
// (the live group timeline, which can fall behind while the socket was dead in
// the background) misses its catch-up. Drive focusManager from Capacitor's
// authoritative `appStateChange` instead, so resuming the app marks the app
// focused and any `refetchOnWindowFocus` query catches up immediately.
if (Capacitor.isNativePlatform()) {
  void CapacitorApp.addListener("appStateChange", ({ isActive }) => {
    focusManager.setFocused(isActive);
  });
  ensureAndroidBackListener();
}

export function App() {
  return (
    <AppProvider storageKey="armada:app-config">
      <ArmadaDBProvider>
        <PlausibleProvider>
          <QueryClientProvider client={queryClient}>
            <NostrLoginProvider storageKey="armada:login" storage={secureStorage}>
              <NostrProvider>
                <WalletProvider>
                  <TooltipProvider>
                    <ReadStateProvider>
                      <WireSync />
                      <NostrSync />
                      <PublishOutbox />
                      <SyncGate />
                    <DBMigrationGate />
                      <DeepLinkWarmup />
                      <DesktopBadge />
                      <NativeNotifications />
                      <NativeReadMarkerSync />
                      <NativeReadDismiss />
                      <WebPushNotifications />
                      <ControlPlaneSync />
                      <ScreenSharePicker />
                      <LoginSetup />
                      <MeshProvider>
                        <AppRouter />
                      </MeshProvider>
                    </ReadStateProvider>
                  </TooltipProvider>
                </WalletProvider>
              </NostrProvider>
            </NostrLoginProvider>
          </QueryClientProvider>
        </PlausibleProvider>
      </ArmadaDBProvider>
    </AppProvider>
  );
}

export default App;
