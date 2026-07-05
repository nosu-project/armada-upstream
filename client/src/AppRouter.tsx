import { BrowserRouter, Navigate, Route, Routes } from "react-router-dom";
import { lazy, Suspense, useEffect, useState, type ReactNode } from "react";

import { useNotificationNavigation } from "@/hooks/useNotificationNavigation";
import {
  coldLaunchPending,
  consumeColdLaunchDeepLink,
  onColdLaunchResolved,
} from "@/lib/coldLaunchDeepLink";
import { BootSplash } from "@/components/brand/BootSplash";
import { MainLayout } from "@/components/layout/MainLayout";
import { useAppContext } from "@/hooks/useAppContext";
import { useCurrentUser } from "@/hooks/useCurrentUser";
import { useMeshTransport } from "@/hooks/useMeshTransport";
import { useOnlineStatus } from "@/hooks/useOnlineStatus";
import { PLATFORM_RELAYS, relayToRouteParam } from "@/lib/platform";

// Route-level code splitting: each page loads as its own chunk on first visit,
// so the boot bundle carries only the shell + the landing route's code. This is
// a large cut on a mid-range Android WebView, where parsing the previously
// monolithic bundle was a visible slice of every cold start.
const AboutPage = lazy(() => import("@/pages/AboutPage").then((m) => ({ default: m.AboutPage })));
const ConcordPage = lazy(() => import("@/concord-v1/pages/ConcordPage").then((m) => ({ default: m.ConcordPage })));
const ConcordV2Page = lazy(() => import("@/concord-v2/pages/ConcordV2Page").then((m) => ({ default: m.ConcordV2Page })));
const DMsPage = lazy(() => import("@/pages/DMsPage").then((m) => ({ default: m.DMsPage })));
const GroupPage = lazy(() => import("@/pages/GroupPage").then((m) => ({ default: m.GroupPage })));
const InvitePage = lazy(() => import("@/concord-v1/pages/InvitePage"));
const InviteV2Page = lazy(() => import("@/concord-v2/pages/InviteV2Page"));
const MeshPage = lazy(() => import("@/pages/MeshPage"));
const NotFound = lazy(() => import("@/pages/NotFound").then((m) => ({ default: m.NotFound })));
const ServerPage = lazy(() => import("@/pages/ServerPage").then((m) => ({ default: m.ServerPage })));
const SettingsPage = lazy(() => import("@/pages/SettingsPage").then((m) => ({ default: m.SettingsPage })));
const SharePage = lazy(() => import("@/pages/SharePage").then((m) => ({ default: m.SharePage })));
const WelcomePage = lazy(() => import("@/pages/WelcomePage").then((m) => ({ default: m.WelcomePage })));

/**
 * Land the user somewhere sensible.
 *
 * A logged-out user always gets the welcome/onboarding screen first — dropping
 * a signed-out user straight into a relay's channel list (which may be slow or
 * AUTH-gated) leaves them staring at a skeleton with no explanation of what
 * Armada is or how to sign in.
 *
 * Once signed in: a hosted deployment has pinned platform relays and goes
 * straight to the first one; a standalone (rogue) client ships with NO pinned
 * relay, so fall back to the user's first added server, or — if they have none
 * yet — the welcome screen (to add one).
 */
function HomeRedirect() {
  const { config } = useAppContext();
  const { user } = useCurrentUser();
  const { mesh } = useMeshTransport();
  const online = useOnlineStatus();

  // Cold launch from a notification tap: the launch URL resolves async (see
  // coldLaunchDeepLink). Hold the default redirect until it's known — otherwise
  // we'd send `/` to the default server, ServerPage would auto-open the default
  // group, and the late deep-link navigate would lose that race. Once resolved,
  // a captured deep link wins; otherwise fall through to the normal default.
  const [state, setState] = useState<{ ready: boolean; deepLink: string | null }>(() =>
    coldLaunchPending()
      ? { ready: false, deepLink: null }
      : { ready: true, deepLink: consumeColdLaunchDeepLink() },
  );
  useEffect(
    () =>
      onColdLaunchResolved(() => {
        setState((prev) => (prev.ready ? prev : { ready: true, deepLink: consumeColdLaunchDeepLink() }));
      }),
    [],
  );

  if (!state.ready) {
    // Launch URL not yet known — committing to a default destination here
    // would lose the race against the deep link, so hold the redirect. Show
    // the branded splash rather than a blank frame (this wait can reach the
    // 1.5s bridge-guard timeout on a slow cold start).
    return <BootSplash />;
  }
  if (state.deepLink) {
    return <Navigate to={state.deepLink} replace />;
  }

  if (!user) {
    return <Navigate to="/welcome" replace />;
  }

  // Offline: the mesh is the only transport that still works — but only where
  // it exists (Android with BLE). Redirecting a web/desktop user to a
  // permanently-unavailable /mesh page is a dead end; they're better off on
  // the cached server view. Hold the redirect briefly while the availability
  // probe resolves so an offline Android launch still lands on mesh.
  if (!online) {
    if (mesh.probing) {
      return <BootSplash />;
    }
    if (mesh.available) {
      return <Navigate to="/mesh" replace />;
    }
  }

  const firstServer = PLATFORM_RELAYS[0] ?? config.addedRelays[0];
  if (!firstServer) {
    // No servers configured (standalone/rogue build): fall back to the mesh
    // where it exists, otherwise the welcome screen to add a server.
    return <Navigate to={mesh.available ? "/mesh" : "/welcome"} replace />;
  }
  return <Navigate to={`/s/${relayToRouteParam(firstServer)}`} replace />;
}

/**
 * Gate a route behind being signed in. Public chat (servers, groups, Concord
 * communities), the invite landing, and the welcome screen render for
 * logged-out users; everything else (DMs, settings) bounces a signed-out user
 * to the landing page rather than showing them an empty, account-scoped shell.
 */
function RequireAuth({ children }: { children: ReactNode }) {
  const { user } = useCurrentUser();
  if (!user) {
    return <Navigate to="/welcome" replace />;
  }
  return <>{children}</>;
}

/**
 * Warm the chat route chunks shortly after boot. Route-level code splitting
 * keeps the boot bundle small, but it also means a LATER navigation — e.g. a
 * notification tap into a room whose page chunk hasn't been visited this
 * session — pauses on the Suspense splash for a chunk fetch + parse. Prefetch
 * the pages a notification tap can target once the landing route has settled,
 * off the critical path (delayed, idle priority), so both hold: small boot
 * AND instant taps.
 */
function useWarmRouteChunks() {
  useEffect(() => {
    const timer = setTimeout(() => {
      for (const load of [
        () => import("@/pages/GroupPage"),
        () => import("@/concord-v1/pages/ConcordPage"),
        () => import("@/concord-v2/pages/ConcordV2Page"),
        () => import("@/pages/DMsPage"),
        () => import("@/pages/ServerPage"),
      ]) {
        void load().catch(() => undefined);
      }
    }, 3000);
    return () => clearTimeout(timer);
  }, []);
}

/**
 * Mounts the notification-tap → React Router navigation bridge. Rendered inside
 * <BrowserRouter> so `useNavigate` resolves; renders nothing.
 */
function NotificationNavigation() {
  useNotificationNavigation();
  return null;
}

export function AppRouter() {
  useWarmRouteChunks();
  return (
    <BrowserRouter future={{ v7_startTransition: true, v7_relativeSplatPath: true }}>
      <NotificationNavigation />
      {/* Lazy route chunks paint the branded splash while they load, never a
          blank frame. */}
      <Suspense fallback={<BootSplash />}>
        <Routes>
          <Route element={<MainLayout />}>
            <Route path="/" element={<HomeRedirect />} />
            <Route path="/welcome" element={<WelcomePage />} />
            <Route path="/s/:server" element={<ServerPage />} />
            <Route path="/s/:server/:groupId" element={<GroupPage />} />
            <Route path="/c1/:communityId" element={<ConcordPage />} />
            <Route path="/c1/:communityId/:channelId" element={<ConcordPage />} />
            <Route path="/c/:communityId" element={<ConcordV2Page />} />
            <Route path="/c/:communityId/:channelId" element={<ConcordV2Page />} />
            {/* V1 invite links carry the token at /invite#…; V2 links carry an
                naddr path segment at /invite/<naddr>#… (CORD-05). */}
            <Route path="/invite" element={<InvitePage />} />
            <Route path="/invite/:naddr" element={<InviteV2Page />} />
            <Route path="/about" element={<AboutPage />} />
            <Route path="/share" element={<SharePage />} />
            <Route path="/mesh" element={<RequireAuth><MeshPage /></RequireAuth>} />
            <Route path="/dms" element={<RequireAuth><DMsPage /></RequireAuth>} />
            <Route path="/dms/:peer" element={<RequireAuth><DMsPage /></RequireAuth>} />
            <Route path="/settings" element={<RequireAuth><SettingsPage /></RequireAuth>} />
          </Route>
          <Route path="*" element={<NotFound />} />
        </Routes>
      </Suspense>
    </BrowserRouter>
  );
}

export default AppRouter;
