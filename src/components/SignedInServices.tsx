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
import { useResumePendingJoins } from "@/concord/hooks/useCommunityActions";
import { useResumeOutgoing } from "@/concord/hooks/useResumeOutgoing";
import { useResumeGuestbookJoins } from "@/concord/hooks/usePendingGuestbookJoin";
import { useWarmDiscover } from "@/hooks/useDiscover";
import { useForegroundNotifications } from "@/hooks/useForegroundNotifications";
import { useNotificationSettingsAbsenceProof } from "@/hooks/useNotificationSettingsAbsenceProof";
import { WireSync } from "@/wire/WireSync";

/**
 * Everything run FOR AN ACCOUNT, as one lazy chunk behind a `user` gate so
 * signed-out visitors don't download it (~half the entry chunk). `App.tsx`
 * prefetches it when `likelySignedIn`. Split in parts only by tree position.
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
      {/* Its own leaf: it reads app config, which changes often. */}
      <NotificationSettingsAbsenceProof />
    </>
  );
}

function NotificationSettingsAbsenceProof() {
  useNotificationSettingsAbsenceProof();
  return null;
}

/** Signed-in services that must sit under `WebPushNotifications`. */
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
 * Signed-in services that must sit inside `<BrowserRouter>`: the foreground
 * notifier (navigates on click), the Discover directory warm, and resuming
 * interrupted Concord joins (`pendingJoins.ts`), their Guestbook Joins
 * (`pendingGuestbookJoin.ts`) and sends (`outgoing.ts`).
 */
export function SignedInRouterServices() {
  useForegroundNotifications();
  useWarmDiscover();
  useResumePendingJoins();
  useResumeOutgoing();
  // Its own leaf: it reads the live community list, which changes often.
  return <GuestbookJoinResume />;
}

function GuestbookJoinResume() {
  useResumeGuestbookJoins();
  return null;
}
