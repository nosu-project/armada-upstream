import { Loader2 } from "lucide-react";
import { useEffect } from "react";

import { useFreshLogin } from "@/hooks/useFreshLogin";
import { useInitialSync } from "@/hooks/useInitialSync";

/**
 * Full-screen post-login sync overlay.
 *
 * After a *fresh* login (not a reload-restored session — see {@link useFreshLogin}),
 * Armada needs to pull the user's encrypted settings, their channel list, and an
 * initial catch-up of messages before the app is trustworthy. Rendering the app
 * underneath at that point flashes empty channels and a default theme that then
 * snap into place a moment later.
 *
 * SyncGate blocks the UI with the same spinner + live status line used during
 * the login handshake (LoginDialog) until {@link useInitialSync} reports `done`.
 * The sync is timeout-bounded, so a slow or dead relay can never trap the user.
 *
 * Mounted alongside NostrSync in App. Renders nothing when there's no fresh
 * login in flight.
 */
export function SyncGate() {
  const { freshPubkey, acknowledge } = useFreshLogin();
  if (!freshPubkey) return null;
  return <SyncOverlay pubkey={freshPubkey} onDone={acknowledge} />;
}

function SyncOverlay({ pubkey, onDone }: { pubkey: string; onDone: () => void }) {
  const { label, done } = useInitialSync(pubkey);

  // When the sync finishes, clear the fresh-login flag so the overlay unmounts
  // and the (now-primed) app shows through.
  useEffect(() => {
    if (done) onDone();
  }, [done, onDone]);

  if (done) return null;

  return (
    <div
      className="fixed inset-0 z-[100] flex flex-col items-center justify-center gap-4 bg-background"
      role="status"
      aria-live="polite"
    >
      <Loader2 className="w-8 h-8 animate-spin text-primary" />
      <p className="text-sm text-muted-foreground text-center min-h-[1.25rem]">{label}</p>
    </div>
  );
}

export default SyncGate;
