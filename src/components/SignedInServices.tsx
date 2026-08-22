import { ControlPlaneSync } from "@/components/ControlPlaneSync";
import { DBMigrationGate } from "@/components/DBMigrationGate";
import { DesktopBadge } from "@/components/DesktopBadge";
import { DmSyncLifecycle } from "@/components/DmSyncLifecycle";
import { NativeNotifications } from "@/components/NativeNotifications";
import { NativeReadDismiss, NativeReadMarkerSync } from "@/components/NativeReadMarkerSync";
import { NostrSync } from "@/components/NostrSync";
import { PublishOutbox } from "@/components/PublishOutbox";
import { ScreenSharePicker } from "@/components/ScreenSharePicker";
import { SyncGate } from "@/components/SyncGate";
import { LoginSetup } from "@/components/onboarding/LoginSetup";
import { useWarmDiscover } from "@/hooks/useDiscover";
import { useForegroundNotifications } from "@/hooks/useForegroundNotifications";
import { WireSync } from "@/wire/WireSync";

/**
 * Everything the app runs FOR AN ACCOUNT: relay sync, the publish outbox, the
 * storage-upgrade and initial-sync gates, notifications, the desktop badge,
 * the post-login setup wizard.
 *
 * These are headless (or full-screen-when-they-fire) siblings of the router,
 * and every one of them is inert without a user — but "inert" was costing the
 * bundle, not the CPU. Statically imported from `App.tsx` they made up roughly
 * half the entry chunk (`WireSync`, `NostrSync`, `useInitialSync` and its
 * conversation-index sync, the push stack, `useConcordUnread` → `useChannel`),
 * which a signed-out visitor downloaded and parsed before the landing page
 * could paint and then never used.
 *
 * So the whole group is one lazy chunk behind a `user` gate. Two things keep
 * that from costing a signed-in user anything:
 *
 *  - `App.tsx` starts the fetch at module scope on a launch that looks signed
 *    in (`likelySignedIn`), so it downloads alongside the entry chunk rather
 *    than after the login state resolves.
 *  - Nothing here needs to run BEFORE a user exists. The one component that
 *    does — `ActiveAccountSync`, which is how the user comes to exist — stays
 *    eager in `App.tsx`, as do the two context providers (`WebPushNotifications`,
 *    `MeshProvider`) whose consumers include signed-out surfaces.
 *
 * Split in two only because of where they sit in the tree: the second group
 * lives INSIDE `WebPushNotifications` and reads its context. Both are in this
 * one module, so they are one chunk and one fetch.
 */
export function SignedInServices() {
  return (
    <>
      <WireSync />
      <DmSyncLifecycle />
      <NostrSync />
      <PublishOutbox />
      <SyncGate />
      <DBMigrationGate />
      <DesktopBadge />
      <NativeNotifications />
      <NativeReadMarkerSync />
      <NativeReadDismiss />
    </>
  );
}

/**
 * The signed-in services that have to sit under `WebPushNotifications` —
 * `LoginSetup` drives the push opt-in and reads its context, and the other two
 * are simply below it in the tree today.
 */
export function SignedInPushServices() {
  return (
    <>
      <ControlPlaneSync />
      <ScreenSharePicker />
      <LoginSetup />
    </>
  );
}

/**
 * The signed-in services that have to sit INSIDE `<BrowserRouter>`.
 *
 * - The foreground (in-page) notifier: selected sounds and inactive-tab
 *   markers plus OS notifications for incoming messages/mentions/DMs. It
 *   navigates on notification click, so it needs the router. Inert on native.
 * - The Discover directory warm: data, not just code — pre-resolve the
 *   directory at idle so the page's first open paints real cards instead of a
 *   skeleton waterfall. That first open is the signup wizard's exit, which is
 *   to say it is always a signed-in one; warming it for a visitor reading the
 *   landing page would be a relay round trip nobody asked for.
 */
export function SignedInRouterServices() {
  useForegroundNotifications();
  useWarmDiscover();
  return null;
}
