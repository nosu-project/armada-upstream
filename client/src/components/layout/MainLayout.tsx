import { Outlet } from "react-router-dom";

/**
 * Application frame. Desktop renders the multi-pane Discord layout (server
 * rail + the routed page's own sidebars). On mobile each route is a single
 * full-screen drill-down level (servers/channels → chat → members), so the
 * shared frame here is intentionally thin — the panes manage their own
 * responsive visibility.
 */
export function MainLayout() {
  return (
    <div className="flex h-full w-full overflow-hidden">
      <Outlet />
    </div>
  );
}
