import { Outlet } from "react-router-dom";

import { ServerRail } from "@/components/layout/ServerRail";

/**
 * Discord-style application frame: a narrow server rail on the far left,
 * with the routed page (server/channel views) filling the rest.
 */
export function MainLayout() {
  return (
    <div className="flex h-full w-full overflow-hidden">
      <ServerRail />
      <div className="flex-1 min-w-0 flex">
        <Outlet />
      </div>
    </div>
  );
}
