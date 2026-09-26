import { BrowserRouter, Navigate, Route, Routes, useLocation, useNavigate, useParams, type Location } from "react-router-dom";
import { lazy, Suspense, useEffect, useMemo, useRef, useState, type ReactNode } from "react";

import { useNotificationNavigation } from "@/hooks/useNotificationNavigation";
import { useShareTargetNavigation } from "@/hooks/useShareTargetNavigation";
import {
  coldLaunchPending,
  consumeColdLaunchDeepLink,
  onColdLaunchResolved,
} from "@/lib/coldLaunchDeepLink";
import {
  coldSharePending,
  consumeColdShareRoute,
  onColdShareResolved,
} from "@/lib/shareTarget";
import { BlankSplash, BootSplash } from "@/components/brand/BootSplash";
import { LocationRefProvider } from "@/components/LocationRefProvider";
import { VersionCheck } from "@/components/VersionCheck";
import { Toaster } from "@/components/ui/toaster";
import { useAppContext } from "@/hooks/useAppContext";
import { useCurrentUser } from "@/hooks/useCurrentUser";
import { useOnboardingActive } from "@/hooks/useOnboarding";
import { useMeshTransport } from "@/hooks/useMeshTransport";
import { useOnlineStatus } from "@/hooks/useOnlineStatus";
import { useNip29Servers } from "@/hooks/useNip29Servers";
import { flattenLayout, mergeLayout, railKeyToRoute } from "@/lib/railLayout";
import { parseJoinLink, setPendingJoin } from "@/lib/joinLink";
import { CONCORD2_PANES } from "@/lib/routes";
import { lazyWithReload } from "@/lib/chunkReload";
import { likelySignedIn } from "@/lib/likelySignedIn";
// NOT lazy, and that is the point: the signed-out landing is the one screen a
// visitor at `/` came for, so it rides in the entry chunk and paints on the
// same tick React mounts rather than after a second round trip. Everything it
// can open (login dialog, signup wizard) is lazy from inside it.
import { WelcomePage } from "@/pages/WelcomePage";
import {
  ProfileOverlayContext,
  profileOverlayPubkey,
  type ProfileBackgroundState,
  type ProfileOverlay,
} from "@/lib/profileOverlay";
import { SettingsOverlayContext, useSettingsOverlayController } from "@/lib/settingsOverlay";

// Route-level code splitting: each page loads as its own chunk on first visit,
// so the boot bundle carries only the shell + the landing, which is imported
// statically above precisely because it is the one screen a signed-out visitor
// came for. This is a large cut on a mid-range Android WebView, where parsing
// the previously monolithic bundle was a visible slice of every cold start.
//
// Each import is wrapped with lazyWithReload so a stale-chunk fetch after a
// deploy (an open tab referencing pruned hashes) triggers a one-time reload to
// a consistent build instead of surfacing as a crash.

// The application frame, and with it the server rail, the call providers, the
// Mini App host (and its fflate) and the quick switcher — none of which a
// signed-out visitor can use. Lazy so the entry chunk is the shell plus the
// landing and nothing else.
const MainLayout = lazy(lazyWithReload(() => import("@/components/layout/MainLayout").then((m) => ({ default: m.MainLayout }))));

// Start the frame's chunk downloading immediately on a signed-in launch, in
// parallel with the entry chunk's own parse, rather than when the router first
// renders a route inside it. Without this, making MainLayout lazy would trade
// a faster signed-out boot for a slower signed-in one.
if (likelySignedIn()) {
  void import("@/components/layout/MainLayout").catch(() => undefined);
}

const LazySignedInRouterServices = lazy(() =>
  import("@/components/SignedInServices").then((m) => ({ default: m.SignedInRouterServices })),
);

const ConcordPage = lazy(lazyWithReload(() => import("@/concord/pages/ConcordPage").then((m) => ({ default: m.ConcordPage }))));
const CreateCommunityPage = lazy(lazyWithReload(() => import("@/pages/CreateCommunityPage").then((m) => ({ default: m.CreateCommunityPage }))));
const DiscordImportPage = lazy(lazyWithReload(() => import("@/pages/DiscordImportPage").then((m) => ({ default: m.DiscordImportPage }))));
const HistoryAuditPage = lazy(lazyWithReload(() => import("@/pages/HistoryAuditPage").then((m) => ({ default: m.HistoryAuditPage }))));
const DiscoverPage = lazy(lazyWithReload(() => import("@/pages/DiscoverPage").then((m) => ({ default: m.DiscoverPage }))));
const DMsPage = lazy(lazyWithReload(() => import("@/pages/DMsPage").then((m) => ({ default: m.DMsPage }))));
const DownloadsPage = lazy(lazyWithReload(() => import("@/pages/DownloadsPage").then((m) => ({ default: m.DownloadsPage }))));
const GroupPage = lazy(lazyWithReload(() => import("@/pages/GroupPage").then((m) => ({ default: m.GroupPage }))));
const InboxPage = lazy(lazyWithReload(() => import("@/pages/InboxPage").then((m) => ({ default: m.InboxPage }))));
const InvitePage = lazy(lazyWithReload(() => import("@/concord/pages/InvitePage")));
const InvitesPage = lazy(lazyWithReload(() => import("@/concord/pages/InvitesPage").then((m) => ({ default: m.InvitesPage }))));
const BuzzInvitePage = lazy(lazyWithReload(() => import("@/buzz/BuzzInvitePage")));
const MeshPage = lazy(lazyWithReload(() => import("@/pages/MeshPage")));
const ChangelogPage = lazy(lazyWithReload(() => import("@/pages/ChangelogPage").then((m) => ({ default: m.ChangelogPage }))));
const NotificationsPage = lazy(lazyWithReload(() => import("@/pages/NotificationsPage").then((m) => ({ default: m.NotificationsPage }))));
const NotFound = lazy(lazyWithReload(() => import("@/pages/NotFound").then((m) => ({ default: m.NotFound }))));
const PrivacyPolicyPage = lazy(lazyWithReload(() => import("@/pages/PrivacyPolicyPage").then((m) => ({ default: m.PrivacyPolicyPage }))));
const ProjectsPage = lazy(lazyWithReload(() => import("@/pages/ProjectsPage").then((m) => ({ default: m.ProjectsPage }))));
const RemoteLoginSuccessPage = lazy(lazyWithReload(() => import("@/pages/RemoteLoginSuccessPage").then((m) => ({ default: m.RemoteLoginSuccessPage }))));
const ServerPage = lazy(lazyWithReload(() => import("@/pages/ServerPage").then((m) => ({ default: m.ServerPage }))));
const SettingsPage = lazy(lazyWithReload(() => import("@/pages/SettingsPage").then((m) => ({ default: m.SettingsPage }))));
const SharePage = lazy(lazyWithReload(() => import("@/pages/SharePage").then((m) => ({ default: m.SharePage }))));
const TermsPage = lazy(lazyWithReload(() => import("@/pages/TermsPage").then((m) => ({ default: m.TermsPage }))));
const UserPage = lazy(lazyWithReload(() => import("@/pages/UserPage").then((m) => ({ default: m.UserPage }))));

/**
 * Dispatch `/invite/<segment>` to the right landing page. A Concord invite's
 * segment is a bech32 `naddr`; a Buzz-style relay invite's is any other code
 * (Buzz's dotted HMAC token, a bare hex token, …), so a segment that
 * isn't an naddr is a relay invite.
 */
function InviteRoute() {
  const { naddr } = useParams<{ naddr: string }>();
  const isBuzz = !!naddr && !/^naddr1/i.test(naddr);
  return isBuzz ? <BuzzInvitePage /> : <InvitePage />;
}

/**
 * A signup "join" / referral link (`/join?relay=wss://op.example`): seed a
 * BRAND-NEW account onto an operator's relay(s). It never touches a signed-in
 * user's own relays — an existing user is simply sent home — and an unusable
 * link (no valid relay) falls through the same way. Otherwise the parsed link
 * is stashed for the signup wizard, which shows a named confirmation before
 * adopting anything.
 */
function JoinRoute() {
  const { user } = useCurrentUser();
  const { search } = useLocation();
  const join = useMemo(() => parseJoinLink(search), [search]);
  if (!user && join) setPendingJoin(join);
  // Both destinations are `/` now — the landing lives there — but the stashed
  // link is what makes the two arrivals differ once it does.
  return <Navigate to="/" replace />;
}

/**
 * Land the user somewhere sensible.
 *
 * A logged-out user gets the landing/onboarding screen — RENDERED HERE, not
 * redirected to. `/` is the landing's own address, so a signed-out visit is a
 * paint rather than a paint, a redirect and a second paint. Dropping a
 * signed-out user straight into a relay's channel list (which may be slow or
 * AUTH-gated) would leave them staring at a skeleton with no explanation of
 * what Armada is or how to sign in.
 *
 * Once signed in: a hosted deployment has pinned platform relays and goes
 * straight to the first one; a standalone (rogue) client ships with NO pinned
 * relay, so fall back to the user's first added server, read from their synced
 * kind-10009 list (via its folded offline snapshot) — or, if they have none
 * yet, DMs.
 */
function HomeRedirect() {
  const { config } = useAppContext();
  const { user } = useCurrentUser();
  const { mesh } = useMeshTransport();
  const online = useOnlineStatus();
  // The signup wizard logs the user in at its key-save step and keeps going
  // into profile setup. Without this, that login would be indistinguishable
  // from any other and the redirects below would yank the user out of the
  // wizard mid-flight. Set synchronously before `login.*`, so it is already
  // true on the commit that first exposes the user.
  const onboarding = useOnboardingActive();

  // Cold launch from a notification tap or an incoming share: the launch
  // intent resolves async (see coldLaunchDeepLink / shareTarget). Hold the
  // default redirect until both are known — otherwise we'd send `/` to the
  // default server, ServerPage would auto-open the default group, and the late
  // navigate would lose that race. A launch intent is a deep link XOR a share
  // (ACTION_VIEW vs ACTION_SEND), so at most one of the two produces a path.
  const [state, setState] = useState<{ ready: boolean; deepLink: string | null }>(() =>
    coldLaunchPending() || coldSharePending()
      ? { ready: false, deepLink: null }
      : { ready: true, deepLink: consumeColdLaunchDeepLink() ?? consumeColdShareRoute() },
  );
  useEffect(() => {
    const check = () => {
      if (coldLaunchPending() || coldSharePending()) return;
      setState((prev) =>
        prev.ready
          ? prev
          : { ready: true, deepLink: consumeColdLaunchDeepLink() ?? consumeColdShareRoute() },
      );
    };
    const offLaunch = onColdLaunchResolved(check);
    const offShare = onColdShareResolved(check);
    return () => {
      offLaunch();
      offShare();
    };
  }, []);

  // Land on the first item of the user's *arranged* community rail — NIP-29
  // servers AND Concord communities intermixed in the order they chose
  // (the same list the far-left rail renders). The persisted `railLayout`
  // lives in app config and is therefore available synchronously on the first
  // render — before the server and Concord lists rehydrate from their folded
  // caches — so the redirect commits to the right destination without racing
  // the rail's async load. `mergeLayout` appends any live NIP-29 server the
  // layout doesn't yet know about (a fresh user who never reordered).
  const liveServers = useNip29Servers();
  const firstRoute = useMemo(() => {
    const servers = new Set(liveServers);
    const ordered = flattenLayout(mergeLayout(config.railLayout, liveServers));
    for (const key of ordered) {
      // A NIP-29 server key (relay URL) is only a valid landing target if the
      // user still has it: the layout keeps keys for items that aren't live
      // yet (lists still loading), so skip those — and skip stale keys from
      // surfaces this client no longer has. Concord
      // keys are always navigable — their page handles a still-loading
      // community.
      if (!key.startsWith("c2:") && !servers.has(key)) continue;
      const route = railKeyToRoute(key);
      if (route) return route;
    }
    return null;
  }, [config.railLayout, liveServers]);

  if (!state.ready) {
    // Launch URL not yet known — committing to a default destination here
    // would lose the race against the deep link, so hold the redirect. Show
    // the branded splash rather than a blank frame (this wait can reach the
    // 1.5s bridge-guard timeout on a slow cold start) — unless we're signed
    // out, in which case the landing below draws the crest itself.
    return user ? <BootSplash /> : <BlankSplash />;
  }
  if (state.deepLink) {
    return <Navigate to={state.deepLink} replace />;
  }

  // The landing itself, and the wizard that grows out of it. `onboarding`
  // keeps this branch selected across the wizard's own login so the component
  // — and the step it is on — survives it.
  if (!user || onboarding) {
    return <WelcomePage />;
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
    // do NOT force the landing here: the create/join onboarding takeover is only
    // for account creation (the signup wizard drives it in-session). Re-forcing
    // it on every page load / relaunch for an already-signed-in, community-less
    // user was the bug — refresh or reopen the app and you'd be dumped back on
    // the getting-started screen. They can always reach create/join from the +
    // in the app.
    if (mesh.available) {
      return <Navigate to="/mesh" replace />;
    }
    // DMs are the usual fallback, but not when the account has opted out of
    // them (config.dmsDisabled): `/dm` bounces back to `/` in that case, so land
    // on Discover directly rather than looping through a hidden inbox.
    return <Navigate to={config.dmsDisabled ? "/discover" : "/dm"} replace />;
  }
  return <Navigate to={firstRoute} replace />;
}

/**
 * Gate a route behind being signed in. Public chat (servers, groups, Concord
 * communities), the invite landing, and the landing page itself render for
 * logged-out users; everything else (DMs, settings) bounces a signed-out user
 * to `/` rather than showing them an empty, account-scoped shell.
 */
function RequireAuth({ children }: { children: ReactNode }) {
  const { user } = useCurrentUser();
  if (!user) {
    return <Navigate to="/" replace />;
  }
  return <>{children}</>;
}

/**
 * Gate the DM routes behind the whole-DM opt-out. When `config.dmsDisabled` is
 * on the account holds no DM subscription at all (see AppConfig), so the inbox
 * is a screen with nothing to show and every entry point into it is hidden —
 * but a stale deep link, an old bookmark or a tray notification can still land
 * here. Send those to `/` rather than the empty inbox; `HomeRedirect` picks the
 * account's real home (a community, or `/discover` when there's none). Wraps
 * `RequireAuth` so a signed-out hit still bounces to the landing first.
 */
function RequireDms({ children }: { children: ReactNode }) {
  const { config } = useAppContext();
  if (config.dmsDisabled) {
    return <Navigate to="/" replace />;
  }
  return <RequireAuth>{children}</RequireAuth>;
}

/**
 * Redirect the old `/dms` paths to `/dm`. Targets that still spell the old path
 * live OUTSIDE this build and cannot be rewritten by shipping it: a push
 * subscription registered before the rename is stored on the relay with
 * `url: "/dms"` until the client next re-registers, and an Android notification
 * already in the tray carries an `armada://open/dms/<peer>` PendingIntent that
 * survives the app update. Search and hash ride along — the notification deep
 * link appends `?message=<id>` to scroll to the message that fired it.
 */
function LegacyDmRedirect() {
  const { peer } = useParams<{ peer: string }>();
  const { search, hash } = useLocation();
  return <Navigate to={`/dm${peer ? `/${peer}` : ""}${search}${hash}`} replace />;
}

/**
 * The outer Suspense fallback — now mostly MainLayout's own chunk, since the
 * frame is lazy. Always the branded splash: the one route that painted its own
 * crest and so wanted a blank handoff (the landing) is in the entry chunk now
 * and never suspends here at all. MainLayout catches its child route chunks
 * inside the page pane.
 */
function RouteFallback() {
  return <BootSplash />;
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
        () => import("@/concord/pages/ConcordPage"),
        () => import("@/pages/DMsPage"),
        () => import("@/pages/NotificationsPage"),
        () => import("@/pages/ServerPage"),
        // Not a notification target, but the landing surface a new user hits
        // first — its first paint shouldn't stack a chunk fetch on top of the
        // directory queries.
        () => import("@/pages/DiscoverPage"),
        // Not a route at all: the profile overlay, which opens OVER one of the
        // pages above. It's the one lazy chunk fetched from inside a session
        // rather than on the way to a page, so nothing else would ever warm it
        // and every first profile of a session paid for it under a spinner.
        () => import("@/components/profile/ProfileDialog"),
        // Drawn over the page from the click itself (`lib/settingsOverlay.ts`),
        // so a cold chunk would be the only thing left between the click and
        // the panel.
        () => import("@/pages/SettingsPage"),
      ]) {
        void load().catch(() => undefined);
      }
    }, 3000);
    return () => clearTimeout(timer);
  }, []);
}

/**
 * Mounts the notification-tap → React Router navigation bridge, and its
 * warm-share sibling. Rendered inside <BrowserRouter> so `useNavigate`
 * resolves; renders nothing.
 */
function NotificationNavigation() {
  useNotificationNavigation();
  useShareTargetNavigation();
  return null;
}

/**
 * The in-router signed-in services (foreground notifier, Discover warm), on
 * the same lazy chunk and the same `user` gate as the rest — see
 * `SignedInServices`. Both reach deep dependency trees (`useForegroundNotifications`
 * the whole notification stack, `useWarmDiscover` → `useCommunityActions` →
 * Concord's control plane and voice), and neither does anything for a
 * signed-out visitor.
 */
function SignedInRouterServicesGate() {
  const { user } = useCurrentUser();
  if (!user) return null;
  return (
    <Suspense fallback={null}>
      <LazySignedInRouterServices />
    </Suspense>
  );
}

/**
 * `location`, keeping the previous object while it names the same history
 * entry.
 *
 * Closing an overlay steps back to the entry it was drawn over, but the
 * location history hands back is a NEW object — rebuilt from `history.state`,
 * not the `backgroundLocation` the page was rendering. Keyed on identity, the
 * routes below would then re-render the whole routed tree for a page that
 * never changed, which is the close that was meant to be free.
 */
function useSameEntry(location: Location): Location {
  const ref = useRef(location);
  const prev = ref.current;
  if (
    prev !== location &&
    !(
      prev.key === location.key &&
      prev.pathname === location.pathname &&
      prev.search === location.search &&
      prev.hash === location.hash
    )
  ) {
    ref.current = location;
  }
  return ref.current;
}

/**
 * The routed app. Split out of `AppRouter` purely so it sits INSIDE
 * <BrowserRouter> and can read the location.
 *
 * That read is what makes the profile a real overlay: a `/<npub>` opened from
 * somewhere carries a `backgroundLocation`, and the routes are then matched
 * against THAT — so the chat behind the profile keeps rendering instead of
 * unmounting and being rebuilt on close (see `lib/profileOverlay.ts`). The
 * profile itself is drawn by `MainLayout`, which owns the pane it covers; all
 * that reaches it from here is the pubkey, since `location=` rewrites
 * `useLocation()` for everything below and this is the last place the real
 * location is visible.
 */
function AppRoutes() {
  const location = useLocation();
  const background = (location.state as ProfileBackgroundState | null)?.backgroundLocation;
  const routedPubkey = background ? profileOverlayPubkey(location.pathname) : undefined;

  // Set by the click, cleared by the navigation it started. Any completed
  // navigation ends it — the one that opens the profile, and equally one that
  // goes somewhere else entirely, so a click that never becomes a profile
  // can't strand the spinner.
  const [opening, setOpening] = useState(false);
  useEffect(() => setOpening(false), [location]);
  const overlay = useMemo<ProfileOverlay>(
    () => ({ pubkey: routedPubkey, opening, begin: () => setOpening(true) }),
    [routedPubkey, opening],
  );
  const settings = useSettingsOverlayController(location, useNavigate());
  // The location the APP is showing, as opposed to the one in the address bar.
  // While a profile or Settings is open these differ, and this is the one that
  // matters.
  const target = useSameEntry(background ?? location);

  // Memoized on that location, which is load-bearing rather than tidiness.
  // `<Routes>` re-derives its route tree from these children on every render,
  // so a render here hands the matched page a fresh element and re-renders the
  // whole routed tree — every message in the open channel included. Opening a
  // profile changes the address bar but NOT `target` (that's the point of the
  // background), so reusing the identical element lets React skip the routed
  // tree entirely and the chat behind the overlay does nothing at all. It
  // still re-renders on a real navigation, when `target` genuinely changes.
  //
  // The overlay itself is unaffected: it's driven by context, and a context
  // update reaches its consumer (MainLayout) through a bailed-out subtree.
  const routes = useMemo(
    () => (
        <Routes location={target}>
          {/* Outside <MainLayout>, and only these three. `/` is the landing —
              the application frame has nothing to offer a signed-out visitor
              and holding the landing behind its chunk would defeat the point
              of the landing being in the entry chunk at all. The other two
              render no UI whatsoever, only a <Navigate>, so routing them
              through the shell would fetch the frame just to leave it. Every
              real page — /privacy, /terms, /changelog, /downloads included —
              stays inside the shell. */}
          <Route path="/" element={<HomeRedirect />} />
          {/* The landing's old address. Kept because it is spelled OUTSIDE
              this build and cannot be rewritten by shipping it: bookmarks, and
              the `window.location.assign` that older builds' logout used. */}
          <Route path="/welcome" element={<Navigate to="/" replace />} />
          <Route path="/join" element={<JoinRoute />} />
          <Route element={<MainLayout />}>
            <Route path="/s/:server" element={<ServerPage />} />
            {/* Static segments outrank the `:groupId` param, so the Projects
                and Inbox views resolve here, not as a channel. */}
            <Route path="/s/:server/projects" element={<ProjectsPage />} />
            <Route path="/s/:server/inbox" element={<RequireAuth><InboxPage /></RequireAuth>} />
            {/* A room, optionally with a thread open and/or a message focused
                (see `lib/routes.ts`). `/t/` and `/m/` are markers rather than
                bare positions so that a thread root's two identities — the
                message in the timeline and the thread it opens — stay
                distinguishable. Each surface renders the same page for all
                four shapes; the page reads the params. */}
            <Route path="/s/:server/:groupId" element={<GroupPage />} />
            <Route path="/s/:server/:groupId/m/:messageId" element={<GroupPage />} />
            <Route path="/s/:server/:groupId/t/:threadRoot" element={<GroupPage />} />
            <Route path="/s/:server/:groupId/t/:threadRoot/m/:messageId" element={<GroupPage />} />
            {/* Every Concord route is behind auth. Membership IS a key the
                account holds (its kind-33302 vault), so there is no signed-out
                view of a community to render — and without this the page
                mounted its whole hook chain, timeline snapshot prewarm
                included, on a route id alone. `CommunityNoAccess` then handles
                the signed-in-but-not-a-member half. */}
            <Route path="/c/:communityId" element={<RequireAuth><ConcordPage /></RequireAuth>} />
            <Route path="/c/:communityId/history" element={<RequireAuth><HistoryAuditPage /></RequireAuth>} />
            {/* Community-wide panes. Static segments outrank `:channelId`, and
                Concord channel ids are hex, so these can never be shadowed by
                a real channel. Kept in one place: `CONCORD2_PANES`. */}
            {CONCORD2_PANES.map((pane) => (
              <Route key={pane} path={`/c/:communityId/${pane}`} element={<RequireAuth><ConcordPage /></RequireAuth>} />
            ))}
            <Route path="/c/:communityId/:channelId" element={<RequireAuth><ConcordPage /></RequireAuth>} />
            <Route path="/c/:communityId/:channelId/m/:messageId" element={<RequireAuth><ConcordPage /></RequireAuth>} />
            <Route path="/c/:communityId/:channelId/t/:threadRoot" element={<RequireAuth><ConcordPage /></RequireAuth>} />
            <Route path="/c/:communityId/:channelId/t/:threadRoot/m/:messageId" element={<RequireAuth><ConcordPage /></RequireAuth>} />
            {/* Concord invite links carry an naddr path segment at
                /invite/<naddr>#… (CORD-05). A Buzz relay invite shares the
                same `/invite/<code>` path (its code is a dotted HMAC token,
                never an naddr), dispatched by InviteRoute. */}
            <Route path="/invite/:naddr" element={<InviteRoute />} />
            <Route path="/changelog" element={<ChangelogPage />} />
            {/* Also a real directory on the hosted deployment, where CI rsyncs
                the installers — nginx serves the SPA shell as its index so a
                reload or a shared link reaches this route rather than the 403
                a directory with no index would otherwise produce. */}
            <Route path="/downloads" element={<DownloadsPage />} />
            <Route path="/privacy" element={<PrivacyPolicyPage />} />
            <Route path="/terms" element={<TermsPage />} />
            <Route path="/share" element={<SharePage />} />
            {/* Callback target baked into nostrconnect:// URIs — remote
                signers redirect here after the user approves pairing. */}
            <Route path="/remoteloginsuccess" element={<RemoteLoginSuccessPage />} />
            {/* Public browse/search directory — no auth (joining/adding prompts
                sign-in at the point of action, like the invite landing). */}
            <Route path="/discover" element={<DiscoverPage />} />
            {/* Full-screen wizards. Routes, not dialogs: each has to outlive the
                Add dialog its entry point sits in (see DiscordImportPage). */}
            <Route path="/create" element={<RequireAuth><CreateCommunityPage /></RequireAuth>} />
            <Route path="/import/discord" element={<RequireAuth><DiscordImportPage /></RequireAuth>} />
            <Route path="/mesh" element={<RequireAuth><MeshPage /></RequireAuth>} />
            {/* The received direct-invite inbox (account-level, CORD-05 §6).
                Distinct from a community's own `/c/:id/invites` link-admin pane. */}
            <Route path="/invites" element={<RequireAuth><InvitesPage /></RequireAuth>} />
            <Route path="/notifications" element={<RequireAuth><NotificationsPage /></RequireAuth>} />
            <Route path="/dm" element={<RequireDms><DMsPage /></RequireDms>} />
            <Route path="/dm/:peer" element={<RequireDms><DMsPage /></RequireDms>} />
            {/* DMs have no thread panel, so no `/t/` shape here. */}
            <Route path="/dm/:peer/m/:messageId" element={<RequireDms><DMsPage /></RequireDms>} />
            {/* Pre-rename links (stale push subscriptions, tray notifications,
                bookmarks). Declared before `/:user`, which would otherwise
                swallow a bare `/dms` and render its own 404. */}
            <Route path="/dms" element={<LegacyDmRedirect />} />
            <Route path="/dms/:peer" element={<LegacyDmRedirect />} />
            <Route path="/settings" element={<RequireAuth><SettingsPage /></RequireAuth>} />
            {/* A person: `/<npub>`, `/<nprofile>`, `/<name@domain>` or
                `/<domain>` — their profile signed in, their chat link signed
                out. The bare NIP-19 path is the ecosystem's convention, so it
                gets no prefix segment of its own. Declared last for
                readability only — React Router ranks every static segment
                above a dynamic one regardless of order — but it DOES outrank
                the `*` route below, so UserPage renders the 404 itself for a
                segment that names nobody. */}
            <Route path="/:user" element={<UserPage />} />
          </Route>
          <Route path="*" element={<NotFound />} />
        </Routes>
    ),
    [target],
  );

  return (
    <ProfileOverlayContext.Provider value={overlay}>
      <SettingsOverlayContext.Provider value={settings}>
        {/* Shell-less lazy routes still paint the branded splash. MainLayout
            keeps waits for its child chunks inside the routed page pane. */}
        <Suspense fallback={<RouteFallback />}>{routes}</Suspense>
      </SettingsOverlayContext.Provider>
    </ProfileOverlayContext.Provider>
  );
}

export function AppRouter() {
  useWarmRouteChunks();
  // No `future` prop on the router: `v7_startTransition` and
  // `v7_relativeSplatPath` were opt-ins under v6 and are the only behavior v7
  // has.
  return (
    <BrowserRouter>
      <NotificationNavigation />
      <SignedInRouterServicesGate />
      <VersionCheck />
      {/* MUST render inside <BrowserRouter>: toasts can carry router <Link>
          actions (e.g. VersionCheck's "What's new" → /changelog). With the
          Toaster outside the router, rendering such a toast throws useHref()
          and unmounts the whole tree to the error screen — which is exactly
          once per release, since VersionCheck stamps the version before
          toasting. */}
      <Toaster />
      <LocationRefProvider>
        <AppRoutes />
      </LocationRefProvider>
    </BrowserRouter>
  );
}

export default AppRouter;
