import { BrowserRouter, Navigate, Route, Routes } from "react-router-dom";

import { MainLayout } from "@/components/layout/MainLayout";
import { ConcordPage } from "@/pages/ConcordPage";
import { DMsPage } from "@/pages/DMsPage";
import { GroupPage } from "@/pages/GroupPage";
import { InvitePage } from "@/pages/InvitePage";
import { NotFound } from "@/pages/NotFound";
import { ServerPage } from "@/pages/ServerPage";
import { SettingsPage } from "@/pages/SettingsPage";
import { WelcomePage } from "@/pages/WelcomePage";
import { useAppContext } from "@/hooks/useAppContext";
import { PLATFORM_RELAYS, relayToRouteParam } from "@/lib/platform";

/**
 * Land the user somewhere sensible. A hosted deployment has pinned platform
 * relays and goes straight to the first one. A standalone (rogue) client ships
 * with NO pinned relay, so fall back to the user's first added server, or — if
 * they have none yet — the welcome/onboarding screen.
 */
function HomeRedirect() {
  const { config } = useAppContext();
  const firstServer = PLATFORM_RELAYS[0] ?? config.addedRelays[0];
  if (!firstServer) {
    return <Navigate to="/welcome" replace />;
  }
  return <Navigate to={`/s/${relayToRouteParam(firstServer)}`} replace />;
}

export function AppRouter() {
  return (
    <BrowserRouter>
      <Routes>
        <Route element={<MainLayout />}>
          <Route path="/" element={<HomeRedirect />} />
          <Route path="/welcome" element={<WelcomePage />} />
          <Route path="/s/:server" element={<ServerPage />} />
          <Route path="/s/:server/:groupId" element={<GroupPage />} />
          <Route path="/c/:communityId" element={<ConcordPage />} />
          <Route path="/invite" element={<InvitePage />} />
          <Route path="/dms" element={<DMsPage />} />
          <Route path="/dms/:peer" element={<DMsPage />} />
          <Route path="/settings" element={<SettingsPage />} />
        </Route>
        <Route path="*" element={<NotFound />} />
      </Routes>
    </BrowserRouter>
  );
}

export default AppRouter;
