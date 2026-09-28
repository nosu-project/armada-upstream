import { Loader2 } from "lucide-react";
import { lazy, Suspense, useContext, useEffect, useRef, type ReactNode } from "react";
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
import { SettingsOverlayContext } from "@/lib/settingsOverlay";
import { lazyWithReload } from "@/lib/chunkReload";

// Lazy: most sessions never open a profile.
const ProfileDialog = lazy(
  lazyWithReload(() =>
    import("@/components/profile/ProfileDialog").then((m) => ({ default: m.ProfileDialog })),
  ),
);
const SettingsPage = lazy(
  lazyWithReload(() => import("@/pages/SettingsPage").then((m) => ({ default: m.SettingsPage }))),
);

/**
 * Profile overlay backdrop + spinner shown between click and panel. Covers the
 * navigation transition (hence `opening` set urgently) as well as the chunk fetch.
 */
function ProfileOverlayFallback({ onDismiss }: { onDismiss?: () => void }) {
  return (
    <div
      className="absolute inset-0 z-20 flex items-center justify-center bg-black/50 backdrop-blur-sm animate-in fade-in-0"
      onClick={onDismiss}
    >
      <Loader2 className="size-8 animate-spin text-muted-foreground" />
    </div>
  );
}

/** Route chunk fallback inside the main pane, so the shell (rail, call providers) stays mounted. */
function RoutePaneFallback() {
  return (
    <div
      className="absolute inset-0 flex items-center justify-center bg-background"
      role="status"
      aria-label="Loading page"
    >
      <Loader2 className="size-8 animate-spin text-muted-foreground" />
    </div>
  );
}

/**
 * Settings over the main pane (`lib/settingsOverlay.ts`); the page below is
 * `inert`. Takes focus on open (Safari never focuses clicked buttons),
 * restores it on close, and handles Escape after stacked dialogs.
 */
function SettingsOverlayPanel({ onClose, children }: { onClose: () => void; children: ReactNode }) {
  const panelRef = useRef<HTMLDivElement>(null);
  const onCloseRef = useRef(onClose);
  onCloseRef.current = onClose;

  useEffect(() => {
    const previous = document.activeElement as HTMLElement | null;
    panelRef.current?.focus({ preventScroll: true });
    return () => {
      if (previous && previous !== document.body && previous.isConnected && !previous.closest("[inert]")) {
        previous.focus({ preventScroll: true });
      }
    };
  }, []);

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== "Escape" || event.defaultPrevented || event.isComposing) return;
      const panel = panelRef.current;
      const stacked = document.querySelectorAll(
        "[role='dialog'], [role='alertdialog'], [role='menu'], [role='listbox']",
      );
      if (Array.from(stacked).some((el) => el !== panel && !panel?.contains(el))) return;
      onCloseRef.current();
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, []);

  return (
    <div
      ref={panelRef}
      role="dialog"
      aria-modal="true"
      aria-label="Settings"
      tabIndex={-1}
      className="absolute inset-0 z-20 flex bg-background outline-none"
    >
      {children}
    </div>
  );
}

/**
 * App frame: multi-pane on desktop, full-screen drill-down on mobile.
 * CallProvider and AppsProvider live here so calls and apps persist across navigation.
 */
export function MainLayout() {
  // Authenticate as every live community's stream keys so auth-gated kind-1059 planes are readable.
  useRegisterAllStreamKeys();
  // Android Direct Share shortcuts. No-op elsewhere.
  useShareShortcuts();
  const navigate = useNavigate();
  // `pubkey` is set only while a profile overlays a mounted page; `opening` is
  // the click that hasn't navigated yet.
  const { pubkey: overlayPubkey, opening } = useContext(ProfileOverlayContext);
  const settings = useContext(SettingsOverlayContext);
  return (
    <CallProvider>
      {/* Inside CallProvider to join/leave, and inside the router for the Android `?call=` deep link. */}
      <DmCallProvider>
      <AppsProvider>
        {/* The ONE persistent rail, so navigation never rebuilds it. On touch it
            portals into each page's SwipeReveal slot — see `getRailPortalNode`. */}
        <ServerRail variant="shell" />
        {/* One positioned box so the profile overlay stops at the rail. Always rendered to avoid reflow. */}
        <div className="relative flex min-w-0 flex-1">
          <div className="contents" inert={settings.open || undefined}>
            <Suspense fallback={<RoutePaneFallback />}>
              <Outlet />
            </Suspense>
          </div>
          {opening && !overlayPubkey && <ProfileOverlayFallback />}
          {overlayPubkey && (
            <Suspense fallback={<ProfileOverlayFallback onDismiss={() => navigate(-1)} />}>
              <ProfileDialog
                pubkey={overlayPubkey}
                // The page underneath is the history entry we step back to; it never unmounted.
                onClose={() => navigate(-1)}
              />
            </Suspense>
          )}
          {settings.open && (
            <SettingsOverlayPanel onClose={settings.close}>
              <Suspense fallback={<RoutePaneFallback />}>
                <SettingsPage section={settings.section} onClose={settings.close} />
              </Suspense>
            </SettingsOverlayPanel>
          )}
        </div>
        <DirectInviteNotifier />
        <QuickSwitcher />
      </AppsProvider>
      </DmCallProvider>
    </CallProvider>
  );
}
