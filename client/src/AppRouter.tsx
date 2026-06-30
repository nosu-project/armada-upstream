import { BrowserRouter, Navigate, Route, Routes } from "react-router-dom";
import { useEffect, useState, type ReactNode } from "react";

import { useNotificationNavigation } from "@/hooks/useNotificationNavigation";
import {
  coldLaunchPending,
  consumeColdLaunchDeepLink,
  onColdLaunchResolved,
} from "@/lib/coldLaunchDeepLink";
import { MainLayout } from "@/components/layout/MainLayout";
import { AboutPage } from "@/pages/AboutPage";
import { ConcordPage } from "@/pages/ConcordPage";
import { DMsPage } from "@/pages/DMsPage";
import { GroupPage } from "@/pages/GroupPage";
import { InvitePage } from "@/pages/InvitePage";
import { NotFound } from "@/pages/NotFound";
import { ServerPage } from "@/pages/ServerPage";
import { SettingsPage } from "@/pages/SettingsPage";
import { WelcomePage } from "@/pages/WelcomePage";
import { useAppContext } from "@/hooks/useAppContext";
import { useCurrentUser } from "@/hooks/useCurrentUser";
import { PLATFORM_RELAYS, relayToRouteParam } from "@/lib/platform";

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
    // Launch URL not yet known — render nothing (blank root / splash) rather
    // than committing to a destination we might immediately have to override.
    return null;
  }
  if (state.deepLink) {
    return <Navigate to={state.deepLink} replace />;
  }

  if (!user) {
    return <Navigate to="/welcome" replace />;
  }

  const firstServer = PLATFORM_RELAYS[0] ?? config.addedRelays[0];
  if (!firstServer) {
    return <Navigate to="/welcome" replace />;
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
 * Mounts the notification-tap → React Router navigation bridge. Rendered inside
 * <BrowserRouter> so `useNavigate` resolves; renders nothing.
 */
function NotificationNavigation() {
  useNotificationNavigation();
  return null;
}

export function AppRouter() {
  return (
    <BrowserRouter>
      <NotificationNavigation />
      <Routes>
        <Route element={<MainLayout />}>
          <Route path="/" element={<HomeRedirect />} />
          <Route path="/welcome" element={<WelcomePage />} />
          <Route path="/s/:server" element={<ServerPage />} />
          <Route path="/s/:server/:groupId" element={<GroupPage />} />
          <Route path="/c/:communityId" element={<ConcordPage />} />
          <Route path="/c/:communityId/:channelId" element={<ConcordPage />} />
          <Route path="/invite" element={<InvitePage />} />
          <Route path="/about" element={<AboutPage />} />
          <Route path="/dms" element={<RequireAuth><DMsPage /></RequireAuth>} />
          <Route path="/dms/:peer" element={<RequireAuth><DMsPage /></RequireAuth>} />
          <Route path="/settings" element={<RequireAuth><SettingsPage /></RequireAuth>} />
        </Route>
        <Route path="*" element={<NotFound />} />
      </Routes>
    </BrowserRouter>
  );
}

export default AppRouter;
