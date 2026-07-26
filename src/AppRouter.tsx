import { BrowserRouter, Navigate, Route, Routes, useParams } from "react-router-dom";
import { lazy, Suspense, useEffect, useMemo, useState, type ReactNode } from "react";

import { useNotificationNavigation } from "@/hooks/useNotificationNavigation";
import { useForegroundNotifications } from "@/hooks/useForegroundNotifications";
import {
  coldLaunchPending,
  consumeColdLaunchDeepLink,
  onColdLaunchResolved,
} from "@/lib/coldLaunchDeepLink";
import { BootSplash } from "@/components/brand/BootSplash";
import { MainLayout } from "@/components/layout/MainLayout";
import { VersionCheck } from "@/components/VersionCheck";
import { Toaster } from "@/components/ui/toaster";
import { useAppContext } from "@/hooks/useAppContext";
import { useCurrentUser } from "@/hooks/useCurrentUser";
import { useMeshTransport } from "@/hooks/useMeshTransport";
import { useOnlineStatus } from "@/hooks/useOnlineStatus";
import { useNip29Servers } from "@/hooks/useNip29Servers";
import { flattenLayout, mergeLayout, railKeyToRoute } from "@/lib/railLayout";
import { lazyWithReload } from "@/lib/chunkReload";

// Route-level code splitting: each page loads as its own chunk on first visit,
// so the boot bundle carries only the shell + the landing route's code. This is
// a large cut on a mid-range Android WebView, where parsing the previously
// monolithic bundle was a visible slice of every cold start.
//
// Each import is wrapped with lazyWithReload so a stale-chunk fetch after a
// deploy (an open tab referencing pruned hashes) triggers a one-time reload to
// a consistent build instead of surfacing as a crash.
const AboutPage = lazy(lazyWithReload(() => import("@/pages/AboutPage").then((m) => ({ default: m.AboutPage }))));
const ConcordPage = lazy(lazyWithReload(() => import("@/concord-v1/pages/ConcordPage").then((m) => ({ default: m.ConcordPage }))));
const ConcordV2Page = lazy(lazyWithReload(() => import("@/concord-v2/pages/ConcordV2Page").then((m) => ({ default: m.ConcordV2Page }))));
const DiscoverPage = lazy(lazyWithReload(() => import("@/pages/DiscoverPage").then((m) => ({ default: m.DiscoverPage }))));
const DMsPage = lazy(lazyWithReload(() => import("@/pages/DMsPage").then((m) => ({ default: m.DMsPage }))));
const GroupPage = lazy(lazyWithReload(() => import("@/pages/GroupPage").then((m) => ({ default: m.GroupPage }))));
const InboxPage = lazy(lazyWithReload(() => import("@/pages/InboxPage").then((m) => ({ default: m.InboxPage }))));
const InvitePage = lazy(lazyWithReload(() => import("@/concord-v1/pages/InvitePage")));
const InviteV2Page = lazy(lazyWithReload(() => import("@/concord-v2/pages/InviteV2Page")));
const BuzzInvitePage = lazy(lazyWithReload(() => import("@/buzz/BuzzInvitePage")));
const MeshPage = lazy(lazyWithReload(() => import("@/pages/MeshPage")));
const ChangelogPage = lazy(lazyWithReload(() => import("@/pages/ChangelogPage").then((m) => ({ default: m.ChangelogPage }))));
const NotFound = lazy(lazyWithReload(() => import("@/pages/NotFound").then((m) => ({ default: m.NotFound }))));
const PrivacyPolicyPage = lazy(lazyWithReload(() => import("@/pages/PrivacyPolicyPage").then((m) => ({ default: m.PrivacyPolicyPage }))));
const ProjectsPage = lazy(lazyWithReload(() => import("@/pages/ProjectsPage").then((m) => ({ default: m.ProjectsPage }))));
const RemoteLoginSuccessPage = lazy(lazyWithReload(() => import("@/pages/RemoteLoginSuccessPage").then((m) => ({ default: m.RemoteLoginSuccessPage }))));
const ServerPage = lazy(lazyWithReload(() => import("@/pages/ServerPage").then((m) => ({ default: m.ServerPage }))));
const SettingsPage = lazy(lazyWithReload(() => import("@/pages/SettingsPage").then((m) => ({ default: m.SettingsPage }))));
const SharePage = lazy(lazyWithReload(() => import("@/pages/SharePage").then((m) => ({ default: m.SharePage }))));
const TermsPage = lazy(lazyWithReload(() => import("@/pages/TermsPage").then((m) => ({ default: m.TermsPage }))));
const WelcomePage = lazy(lazyWithReload(() => import("@/pages/WelcomePage").then((m) => ({ default: m.WelcomePage }))));

/**
 * Dispatch `/invite/<segment>` to the right landing page. A Concord V2 invite's
 * segment is a bech32 `naddr`; a Buzz relay invite's is a dotted HMAC token
 * (contains `.`, never bech32), so the shapes never collide.
 */
function InviteRoute() {
  const { naddr } = useParams<{ naddr: string }>();
  const isBuzz = !!naddr && !/^naddr1/i.test(naddr) && naddr.includes(".");
  return isBuzz ? <BuzzInvitePage /> : <InviteV2Page />;
}

/**
 * Land the user somewhere sensible.
 *
 * A logged-out user always gets the welcome/onboarding screen first — dropping
 * a signed-out user straight into a relay's channel list (which may be slow or
 * AUTH-gated) leaves them staring at a skeleton with no explanation of what
 * Armada is or how to sign in.
 *
 * Once signed in: a hosted deployment has pinned platform relays and goes
 * straight to the first one; a standalone (rogue) client ships with NO pinned
 * relay, so fall back to the user's first added server, read from their synced
 * kind-10009 list (via its folded offline snapshot) — or, if they have none
 * yet, the welcome screen (to add one).
 */
function HomeRedirect() {
  const { config } = useAppContext();
  const { user } = useCurrentUser();
  const { mesh } = useMeshTransport();
  const online = useOnlineStatus();

  // Cold launch from a notification tap: the launch URL resolves async (see
  // coldLaunchDeepLink). Hold the default redirect until it's known — otherwise
  // we'd send `/` to the default server, ServerPage would auto-open the default
  // group, and the late deep-link navigate would lose that race. Once resolved,
  // a captured deep link wins; otherwise fall through to the normal default.
  const [state, setState] = useState<{ ready: boolean; deepLink: string | null }>(() =>
    coldLaunchPending()
      ? { ready: false, deepLink: null }
      : { ready: true, deepLink: consumeColdLaunchDeepLink() },
  );
  useEffect(
    () =>
      onColdLaunchResolved(() => {
        setState((prev) => (prev.ready ? prev : { ready: true, deepLink: consumeColdLaunchDeepLink() }));
      }),
    [],
  );

  // Land on the first item of the user's *arranged* community rail — NIP-29
  // servers AND Concord V1/V2 communities intermixed in the order they chose
  // (the same list the far-left rail renders). The persisted `railLayout`
  // (seeded from the legacy flat `railOrder`) lives in app config and is
  // therefore available synchronously on the first render — before the server
  // and Concord lists rehydrate from their folded caches — so the redirect
  // commits to the right destination without racing the rail's async load.
  // `mergeLayout` seeds the working order from `railOrder` and appends any
  // live NIP-29 server the layout doesn't yet know about (a fresh user who
  // never reordered).
  const liveServers = useNip29Servers();
  const firstRoute = useMemo(() => {
    const servers = new Set(liveServers);
    const ordered = flattenLayout(
      mergeLayout(config.railLayout, config.railOrder, liveServers),
    );
    for (const key of ordered) {
      // A NIP-29 server key (relay URL) is only a valid landing target if the
      // user still has it: the layout keeps keys for items that aren't live
      // yet (lists still loading), so skip those. Concord keys are always
      // navigable — their page handles a still-loading community.
      if (!key.startsWith("c1:") && !key.startsWith("c2:") && !servers.has(key)) continue;
      const route = railKeyToRoute(key);
      if (route) return route;
    }
    return null;
  }, [config.railLayout, config.railOrder, liveServers]);

  if (!state.ready) {
    // Launch URL not yet known — committing to a default destination here
    // would lose the race against the deep link, so hold the redirect. Show
    // the branded splash rather than a blank frame (this wait can reach the
    // 1.5s bridge-guard timeout on a slow cold start).
    return <BootSplash />;
  }
  if (state.deepLink) {
    return <Navigate to={state.deepLink} replace />;
  }

  if (!user) {
    return <Navigate to="/welcome" replace />;
  }

  // Offline: the mesh is the only transport that still works — but only where
  // it exists (Android with BLE). Redirecting a web/desktop user to a
  // permanently-unavailable /mesh page is a dead end; they're better off on
  // the cached server view. Hold the redirect briefly while the availability
  // probe resolves so an offline Android launch still lands on mesh.
  if (!online) {
    if (mesh.probing) {
      return <BootSplash />;
    }
    if (mesh.available) {
      return <Navigate to="/mesh" replace />;
    }
  }

  if (!firstRoute) {
    // Signed in but no community yet. The mesh is the home where it exists
    // (Android); otherwise land on DMs — a real, usable screen. We deliberately
    // do NOT force /welcome here: the create/join onboarding takeover is only
    // for account creation (the signup wizard drives it in-session). Re-forcing
    // it on every page load / relaunch for an already-signed-in, community-less
    // user was the bug — refresh or reopen the app and you'd be dumped back on
    // the getting-started screen. They can always reach create/join from the +
    // in the app.
    if (mesh.available) {
      return <Navigate to="/mesh" replace />;
    }
    return <Navigate to="/dms" replace />;
  }
  return <Navigate to={firstRoute} replace />;
}

/**
 * Gate a route behind being signed in. Public chat (servers, groups, Concord
 * communities), the invite landing, and the welcome screen render for
 * logged-out users; everything else (DMs, settings) bounces a signed-out user
 * to the landing page rather than showing them an empty, account-scoped shell.
 */
function RequireAuth({ children }: { children: ReactNode }) {
  const { user } = useCurrentUser();
  if (!user) {
    return <Navigate to="/welcome" replace />;
  }
  return <>{children}</>;
}

/**
 * Warm the chat route chunks shortly after boot. Route-level code splitting
 * keeps the boot bundle small, but it also means a LATER navigation — e.g. a
 * notification tap into a room whose page chunk hasn't been visited this
 * session — pauses on the Suspense splash for a chunk fetch + parse. Prefetch
 * the pages a notification tap can target once the landing route has settled,
 * off the critical path (delayed, idle priority), so both hold: small boot
 * AND instant taps.
 */
function useWarmRouteChunks() {
  useEffect(() => {
    const timer = setTimeout(() => {
      for (const load of [
        () => import("@/pages/GroupPage"),
        () => import("@/concord-v1/pages/ConcordPage"),
        () => import("@/concord-v2/pages/ConcordV2Page"),
        () => import("@/pages/DMsPage"),
        () => import("@/pages/ServerPage"),
      ]) {
        void load().catch(() => undefined);
      }
    }, 3000);
    return () => clearTimeout(timer);
  }, []);
}

/**
 * Mounts the notification-tap → React Router navigation bridge. Rendered inside
 * <BrowserRouter> so `useNavigate` resolves; renders nothing.
 */
function NotificationNavigation() {
  useNotificationNavigation();
  return null;
}

/**
 * Runs the foreground (in-page) notifier: toasts while focused, OS
 * notifications while backgrounded, for incoming messages/mentions/DMs. Must be
 * inside the router (it navigates on notification click). Inert on native.
 */
function ForegroundNotifications() {
  useForegroundNotifications();
  return null;
}

export function AppRouter() {
  useWarmRouteChunks();
  return (
      <BrowserRouter future={{ v7_startTransition: true, v7_relativeSplatPath: true }}>
        <NotificationNavigation />
        <ForegroundNotifications />
        <VersionCheck />
        {/* MUST render inside <BrowserRouter>: toasts can carry router <Link>
            actions (e.g. VersionCheck's "What's new" → /changelog). With the
            Toaster outside the router, rendering such a toast throws useHref()
            and unmounts the whole tree to the error screen — which is exactly
            once per release, since VersionCheck stamps the version before
            toasting. */}
        <Toaster />
        {/* Lazy route chunks paint the branded splash while they load, never a
            blank frame. */}
      <Suspense fallback={<BootSplash />}>
        <Routes>
          <Route element={<MainLayout />}>
            <Route path="/" element={<HomeRedirect />} />
            <Route path="/welcome" element={<WelcomePage />} />
            <Route path="/s/:server" element={<ServerPage />} />
            {/* Static segments outrank the `:groupId` param, so the Projects
                and Inbox views resolve here, not as a channel. */}
            <Route path="/s/:server/projects" element={<ProjectsPage />} />
            <Route path="/s/:server/inbox" element={<RequireAuth><InboxPage /></RequireAuth>} />
            <Route path="/s/:server/:groupId" element={<GroupPage />} />
            <Route path="/c1/:communityId" element={<ConcordPage />} />
            <Route path="/c1/:communityId/:channelId" element={<ConcordPage />} />
            <Route path="/c/:communityId" element={<ConcordV2Page />} />
            <Route path="/c/:communityId/:channelId" element={<ConcordV2Page />} />
            {/* V1 invite links carry the token at /invite#…; V2 links carry an
                naddr path segment at /invite/<naddr>#… (CORD-05). A Buzz relay
                invite shares the same `/invite/<code>` path (its code is a
                dotted HMAC token, never an naddr), dispatched by InviteRoute. */}
            <Route path="/invite" element={<InvitePage />} />
            <Route path="/invite/:naddr" element={<InviteRoute />} />
            <Route path="/about" element={<AboutPage />} />
            <Route path="/changelog" element={<ChangelogPage />} />
            <Route path="/privacy" element={<PrivacyPolicyPage />} />
            <Route path="/terms" element={<TermsPage />} />
            <Route path="/share" element={<SharePage />} />
            {/* Callback target baked into nostrconnect:// URIs — remote
                signers redirect here after the user approves pairing. */}
            <Route path="/remoteloginsuccess" element={<RemoteLoginSuccessPage />} />
            {/* Public browse/search directory — no auth (joining/adding prompts
                sign-in at the point of action, like the invite landing). */}
            <Route path="/discover" element={<DiscoverPage />} />
            <Route path="/mesh" element={<RequireAuth><MeshPage /></RequireAuth>} />
            <Route path="/dms" element={<RequireAuth><DMsPage /></RequireAuth>} />
            <Route path="/dms/:peer" element={<RequireAuth><DMsPage /></RequireAuth>} />
            <Route path="/settings" element={<RequireAuth><SettingsPage /></RequireAuth>} />
          </Route>
          <Route path="*" element={<NotFound />} />
        </Routes>
      </Suspense>
    </BrowserRouter>
  );
}

export default AppRouter;
