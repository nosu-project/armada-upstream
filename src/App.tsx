// NOTE: This file should normally not be modified unless you are adding a new provider.
// To add new routes, edit the AppRouter.tsx file.

import { App as CapacitorApp } from "@capacitor/app";
import { Capacitor } from "@capacitor/core";
import { NostrLoginProvider } from "@nostrify/react/login";
import { focusManager, QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { lazy, Suspense } from "react";

import { ensureAndroidBackListener } from "@/hooks/useAndroidBack";
import { useCurrentUser } from "@/hooks/useCurrentUser";
import { AccountExitGate } from "@/components/AccountExitGate";
import { ActiveAccountSync } from "@/components/ActiveAccountSync";
import { AppProvider } from "@/components/AppProvider";
import { ArmadaDBProvider } from "@/components/ArmadaDBProvider";
import { DeepLinkWarmup } from "@/components/DeepLinkWarmup";
import { MeshProvider } from "@/components/MeshProvider";
import { MutedPubkeysProvider } from "@/components/MutedPubkeysProvider";
import NostrProvider from "@/components/NostrProvider";
import { PlausibleProvider } from "@/components/PlausibleProvider";
import { ReadStateProvider } from "@/components/ReadStateProvider";
import { TooltipProvider } from "@/components/ui/tooltip";
import WalletProvider from "@/components/WalletProvider";
import { WebPushNotifications } from "@/components/WebPushNotifications";
import { initGroupKeyPersistence } from "@/concord/lib/groupKeyPersist";
import { secureStorage } from "@/lib/secureStorage";
import { APP_CONFIG_STORAGE_KEY } from "@/lib/activeAccount";
import { likelySignedIn } from "@/lib/likelySignedIn";
import { LOGIN_STORAGE_KEY } from "@/lib/switchAccount";

import AppRouter from "./AppRouter";

// Every per-account service in one lazy chunk — see SignedInServices for what
// is in it and why. A signed-out visitor never fetches it at all.
const LazySignedInServices = lazy(() =>
  import("@/components/SignedInServices").then((m) => ({ default: m.SignedInServices })),
);
const LazySignedInPushServices = lazy(() =>
  import("@/components/SignedInServices").then((m) => ({ default: m.SignedInPushServices })),
);

// On a launch that looks signed in, start that fetch NOW — in parallel with
// the entry chunk's own parse — rather than when the login state finishes
// resolving. Without this, deferring the services would trade a faster
// signed-out boot for a slower signed-in one.
if (likelySignedIn()) {
  void import("@/components/SignedInServices").catch(() => undefined);
}

/**
 * Mount the per-account services once there is an account.
 *
 * The gate has to live OUT here, above the lazy boundary: putting the `user`
 * check inside the lazy component would mean fetching the chunk in order to
 * discover it has nothing to do. `fallback={null}` because every one of these
 * is headless until it decides otherwise — there is nothing to show while the
 * chunk is in flight, and showing something would be worse than showing
 * nothing.
 */
function SignedInServicesGate({ variant }: { variant: "core" | "push" }) {
  const { user } = useCurrentUser();
  if (!user) return null;
  const Services = variant === "core" ? LazySignedInServices : LazySignedInPushServices;
  return (
    <Suspense fallback={null}>
      <Services />
    </Suspense>
  );
}

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

// Hydrate the Concord groupKey memo from KV at module load — before the
// community list resolves and channelsView derives every stream key. A warm
// boot then pays no secp256k1 point multiplications for last session's keys.
void initGroupKeyPersistence();

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
    <AppProvider storageKey={APP_CONFIG_STORAGE_KEY}>
      <ArmadaDBProvider>
        <PlausibleProvider>
          <QueryClientProvider client={queryClient}>
            <NostrLoginProvider storageKey={LOGIN_STORAGE_KEY} storage={secureStorage}>
              <ActiveAccountSync />
              {/* The account-exit overlay lives ABOVE the signed-in gate: a
                  logout/switch removes the login moments before it reloads, and
                  a gate mounted below would unmount with it and flash the app
                  back for the sliver before the reload lands. */}
              <AccountExitGate />
              <NostrProvider>
                <WalletProvider>
                  <TooltipProvider>
                    <ReadStateProvider>
                      <MutedPubkeysProvider>
                      <SignedInServicesGate variant="core" />
                      {/* Stays eager: a cold-launch deep link resolves before
                          the login state does, and this is what overlaps the
                          room's first REQ with React mounting the route. */}
                      <DeepLinkWarmup />
                      <WebPushNotifications>
                        <SignedInServicesGate variant="push" />
                        <MeshProvider>
                          <AppRouter />
                        </MeshProvider>
                      </WebPushNotifications>
                      </MutedPubkeysProvider>
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
