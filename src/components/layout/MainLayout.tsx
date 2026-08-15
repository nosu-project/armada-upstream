import { Outlet } from "react-router-dom";

import { AppsProvider } from "@/components/AppsProvider";
import { CallProvider } from "@/components/CallProvider";
import { DmCallProvider } from "@/components/DmCallProvider";
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
      {/* DM call signaling (ring in/out, offer/answer rumors) sits inside
          CallProvider so it can join/leave the room, and inside the router so
          the Android Answer deep link (`?call=`) reaches it. */}
      <DmCallProvider>
      <AppsProvider>
        {/* The ONE persistent server rail, owned here so navigating between
            sections never unmounts and rebuilds it — its per-item hook fan-out
            and the tap target — on every switch. On the desktop side-by-side
            layout it renders in place as a sibling of the routed page
            (`AppsProvider` passes children straight through, so this lands as
            the first flex child of CallProvider's row). On the touch
            drill-down it renders through a portal into a shared container
            whose DOM each page's `<ServerRail />` slot adopts inside its
            SwipeReveal underlay — see the note above `getRailPortalNode`. */}
        <ServerRail variant="shell" />
        <Outlet />
        <DirectInviteNotifier />
        <QuickSwitcher />
      </AppsProvider>
      </DmCallProvider>
    </CallProvider>
  );
}
