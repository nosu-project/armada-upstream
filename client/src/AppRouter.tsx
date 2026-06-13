import { BrowserRouter, Navigate, Route, Routes } from "react-router-dom";

import { MainLayout } from "@/components/layout/MainLayout";
import { GroupPage } from "@/pages/GroupPage";
import { NotFound } from "@/pages/NotFound";
import { ServerPage } from "@/pages/ServerPage";
import { SettingsPage } from "@/pages/SettingsPage";
import { PLATFORM_RELAYS, relayToRouteParam } from "@/lib/platform";

export function AppRouter() {
  const home = `/s/${relayToRouteParam(PLATFORM_RELAYS[0])}`;

  return (
    <BrowserRouter>
      <Routes>
        <Route element={<MainLayout />}>
          <Route path="/" element={<Navigate to={home} replace />} />
          <Route path="/s/:server" element={<ServerPage />} />
          <Route path="/s/:server/:groupId" element={<GroupPage />} />
          <Route path="/settings" element={<SettingsPage />} />
        </Route>
        <Route path="*" element={<NotFound />} />
      </Routes>
    </BrowserRouter>
  );
}

export default AppRouter;
