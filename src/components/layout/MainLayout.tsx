import { Loader2 } from "lucide-react";
import { lazy, Suspense, useContext } from "react";
import { Outlet, useNavigate } from "react-router-dom";

import { AppsProvider } from "@/components/AppsProvider";
import { CallProvider } from "@/components/CallProvider";
import { DmCallProvider } from "@/components/DmCallProvider";
import { DirectInviteNotifier } from "@/concord/components/DirectInviteNotifier";
import { QuickSwitcher } from "@/components/QuickSwitcher";
import { ServerRail } from "@/components/layout/ServerRail";
import { useRegisterAllStreamKeys } from "@/concord/hooks/useStreamAuth";
import { useShareShortcuts } from "@/hooks/useShareShortcuts";
import { ProfileOverlayContext } from "@/lib/profileOverlay";
import { lazyWithReload } from "@/lib/chunkReload";

// Loaded on first use like a route chunk: most sessions never open a profile,
// and this pulls in the theme/badge/shared-community machinery behind it.
const ProfileDialog = lazy(
  lazyWithReload(() =>
    import("@/components/profile/ProfileDialog").then((m) => ({ default: m.ProfileDialog })),
  ),
);

/**
 * What stands in for the profile between the click and the panel: the
 * overlay's own backdrop with a spinner in it, in the same pane and at the
 * same z as the real thing, so the panel lands ON this rather than after a
 * flash of un-dimmed chat.
 *
 * There IS a gap to fill even though the chunk is warmed at idle
 * (`useWarmRouteChunks`) — the warm can lose to a click made early in the
 * session, and a cold cache after a deploy has to fetch it. Dismissible,
 * because a spinner you can't back out of is worse than the wait.
 */
function ProfileOverlayFallback({ onDismiss }: { onDismiss: () => void }) {
  return (
    <div
      className="absolute inset-0 z-20 flex items-center justify-center bg-black/50 backdrop-blur-sm animate-in fade-in-0"
      onClick={onDismiss}
    >
      <Loader2 className="size-8 animate-spin text-muted-foreground" />
    </div>
  );
}

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
  const navigate = useNavigate();
  // Set only while a profile is drawing over a page that is still mounted; a
  // `/<npub>` reached cold routes to UserPage instead and draws its own.
  const overlayPubkey = useContext(ProfileOverlayContext);
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
        {/* The main pane: everything beside the rail, as ONE positioned box.
            It exists so the profile overlay has something to fill that stops
            at the rail — the rail stays lit and clickable, because it is how
            you leave. Desktop puts the rail outside this box; touch portals
            the rail INTO the page, where a full-pane overlay is what's wanted
            anyway. Always rendered, overlay or not, so opening one doesn't
            reflow the page beneath it. */}
        <div className="relative flex min-w-0 flex-1">
          <Outlet />
          {overlayPubkey && (
            <Suspense fallback={<ProfileOverlayFallback onDismiss={() => navigate(-1)} />}>
              <ProfileDialog
                pubkey={overlayPubkey}
                // Closing is a history step, and the page underneath is the
                // entry it steps back to — it never unmounted.
                onClose={() => navigate(-1)}
              />
            </Suspense>
          )}
        </div>
        <DirectInviteNotifier />
        <QuickSwitcher />
      </AppsProvider>
      </DmCallProvider>
    </CallProvider>
  );
}
