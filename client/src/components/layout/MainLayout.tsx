import { Outlet } from "react-router-dom";

import { CallProvider } from "@/components/CallProvider";

/**
 * Application frame. Desktop renders the multi-pane Discord layout (server
 * rail + the routed page's own sidebars). On mobile each route is a single
 * full-screen drill-down level (servers/channels → chat → members), so the
 * shared frame here is intentionally thin — the panes manage their own
 * responsive visibility.
 *
 * The CallProvider lives here (the layout never unmounts on navigation) so a
 * voice call persists across channel/server changes; it wraps the routed
 * content and docks the call bar below it.
 */
export function MainLayout() {
  return (
    <CallProvider>
      <Outlet />
    </CallProvider>
  );
}
