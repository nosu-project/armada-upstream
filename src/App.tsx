// NOTE: This file should normally not be modified unless you are adding a new provider.
// To add new routes, edit the AppRouter.tsx file.

import { App as CapacitorApp } from "@capacitor/app";
import { Capacitor } from "@capacitor/core";
import { NostrLoginProvider } from "@nostrify/react/login";
import { focusManager, QueryClient, QueryClientProvider } from "@tanstack/react-query";

import { ensureAndroidBackListener } from "@/hooks/useAndroidBack";
import { AppProvider } from "@/components/AppProvider";
import { ControlPlaneSync } from "@/components/ControlPlaneSync";
import { DecryptConsentDialog } from "@/components/DecryptConsentDialog";
import { DeepLinkWarmup } from "@/components/DeepLinkWarmup";
import { DesktopBadge } from "@/components/DesktopBadge";
import { MeshProvider } from "@/components/MeshProvider";
import { NativeNotifications } from "@/components/NativeNotifications";
import { NativeReadDismiss, NativeReadMarkerSync } from "@/components/NativeReadMarkerSync";
import NostrProvider from "@/components/NostrProvider";
import { NostrSync } from "@/components/NostrSync";
import { PlausibleProvider } from "@/components/PlausibleProvider";
import { PublishOutbox } from "@/components/PublishOutbox";
import { ReadStateProvider } from "@/components/ReadStateProvider";
import { ScreenSharePicker } from "@/components/ScreenSharePicker";
import { SyncGate } from "@/components/SyncGate";
import { TooltipProvider } from "@/components/ui/tooltip";
import WalletProvider from "@/components/WalletProvider";
import { WebPushNotifications } from "@/components/WebPushNotifications";
import { WireSync } from "@/wire/WireSync";
import { secureStorage } from "@/lib/secureStorage";

import AppRouter from "./AppRouter";

const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      refetchOnWindowFocus: false,
      staleTime: 60000, // 1 minute
      gcTime: 300000, // 5 minutes
    },
  },
});

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
                    <DeepLinkWarmup />
                    <DesktopBadge />
                    <NativeNotifications />
                    <NativeReadMarkerSync />
                    <NativeReadDismiss />
                    <WebPushNotifications />
                    <ControlPlaneSync />
                    <ScreenSharePicker />
                    <DecryptConsentDialog />
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
    </AppProvider>
  );
}

export default App;
