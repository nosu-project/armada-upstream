import { Outlet } from "react-router-dom";

import { AppsProvider } from "@/components/AppsProvider";
import { CallProvider } from "@/components/CallProvider";
import { ConcordInvitesPrompt } from "@/components/ConcordInvitesPrompt";
import { QuickSwitcher } from "@/components/QuickSwitcher";

/**
 * Application frame. Desktop renders the multi-pane Discord layout (server
 * rail + the routed page's own sidebars). On mobile each route is a single
 * full-screen drill-down level (servers/channels → chat → members), so the
 * shared frame here is intentionally thin — the panes manage their own
 * responsive visibility.
 *
 * The CallProvider and AppsProvider live here (the layout never unmounts on
 * navigation) so a voice call and an in-chat app persist across channel/server
 * changes; they wrap the routed content and dock their UI below it.
 */
export function MainLayout() {
  return (
    <CallProvider>
      <AppsProvider>
        <Outlet />
        <ConcordInvitesPrompt />
        <QuickSwitcher />
      </AppsProvider>
    </CallProvider>
  );
}
