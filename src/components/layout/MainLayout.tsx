import { Outlet } from "react-router-dom";

import { AppsProvider } from "@/components/AppsProvider";
import { CallProvider } from "@/components/CallProvider";
import { DirectInviteNotifier } from "@/concord/components/DirectInviteNotifier";
import { QuickSwitcher } from "@/components/QuickSwitcher";
import { ServerRail } from "@/components/layout/ServerRail";
import { useRegisterAllStreamKeys } from "@/concord/hooks/useStreamAuth";
import { useShareShortcuts } from "@/hooks/useShareShortcuts";

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
  // Concord rides auth-gated kind-1059 streams: authenticate the connection
  // as every live community's derived stream keys so its planes are readable.
  useRegisterAllStreamKeys();
  // Android: keep the Direct Share suggestions (share-sheet conversation
  // shortcuts) in step with the user's pinned + recent DMs. No-op elsewhere.
  useShareShortcuts();
  return (
    <CallProvider>
      <AppsProvider>
        {/* The persistent server rail on the desktop side-by-side layout: a
            sibling of the routed page (not a child), so navigating between
            communities no longer unmounts and rebuilds the whole rail — its
            per-item hook fan-out and the tap target — on every switch. On the
            touch drill-down it renders nothing; there each page still owns its
            own rail inside its SwipeReveal underlay. `AppsProvider` passes
            children straight through, so this lands as the first flex child of
            CallProvider's row — exactly where the page-owned rail sat. */}
        <ServerRail variant="shell" />
        <Outlet />
        <DirectInviteNotifier />
        <QuickSwitcher />
      </AppsProvider>
    </CallProvider>
  );
}
