import { useEffect, useSyncExternalStore } from "react";

import { ArmadaCrest, ArmadaCrestKeyframes } from "@/components/brand/ArmadaCrest";
import { BrandMark } from "@/components/brand/BrandMark";
import { TerminalProgress } from "@/components/brand/TerminalProgress";
import { useFreshLogin } from "@/hooks/useFreshLogin";
import { useInitialSync } from "@/hooks/useInitialSync";

/**
 * Full-screen post-login sync overlay.
 *
 * After a *fresh* login (not a reload-restored session, see {@link useFreshLogin}),
 * Armada needs to pull the user's encrypted settings, their channel list, an
 * initial catch-up of messages, and their encrypted Concord communities before
 * the app is trustworthy. Rendering the app underneath at that point flashes
 * empty channels and a default theme that then snap into place a moment later.
 *
 * SyncGate blocks the UI with the Armada crest, the wordmark, and a vertical
 * terminal-style progress list (one line per sync step) until
 * {@link useInitialSync} reports `done`. The sync is timeout-bounded, so a slow
 * or dead relay can never trap the user.
 *
 * Mounted alongside NostrSync in App. Renders nothing when there's no fresh
 * login in flight.
 */
export function SyncGate() {
  const { freshPubkey, acknowledge } = useFreshLogin();
  if (!freshPubkey) return null;
  return <SyncOverlay pubkey={freshPubkey} onDone={acknowledge} />;
}

// ── "Is the gate up?" ────────────────────────────────────────────────────────
// The post-login setup flow must not start stacking its steps while the sync
// overlay is still running, so it subscribes here rather than mounting a second
// useFreshLogin (whose baseline/acknowledge state is per-instance and would
// never clear).

let gateActive = false;
const gateListeners = new Set<() => void>();

function setGateActive(next: boolean): void {
  if (gateActive === next) return;
  gateActive = next;
  for (const l of gateListeners) l();
}

/** Whether the full-screen post-login sync overlay is currently showing. */
export function useSyncGateActive(): boolean {
  return useSyncExternalStore(
    (listener) => {
      gateListeners.add(listener);
      return () => {
        gateListeners.delete(listener);
      };
    },
    () => gateActive,
    () => false,
  );
}

function SyncOverlay({ pubkey, onDone }: { pubkey: string; onDone: () => void }) {
  const { log, done } = useInitialSync(pubkey);

  useEffect(() => {
    setGateActive(true);
    return () => setGateActive(false);
  }, []);

  // When the sync finishes, hold a brief beat so the final line lands, then
  // clear the fresh-login flag so the overlay unmounts and the (now-primed)
  // app shows through.
  useEffect(() => {
    if (!done) return;
    const t = setTimeout(onDone, 500);
    return () => clearTimeout(t);
  }, [done, onDone]);

  return (
    <div
      className="fixed inset-0 z-[100] flex flex-col items-center justify-center gap-10 bg-background px-6"
      role="status"
      aria-live="polite"
    >
      <div className="flex flex-col items-center gap-6">
        <ArmadaCrest size={96} />
        <BrandMark />
      </div>

      <TerminalProgress lines={log} />

      <ArmadaCrestKeyframes />
    </div>
  );
}

export default SyncGate;
