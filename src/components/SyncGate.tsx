import { useEffect, useState, useSyncExternalStore } from "react";

import { ArmadaCrest, ArmadaCrestKeyframes } from "@/components/brand/ArmadaCrest";
import { BrandMark } from "@/components/brand/BrandMark";
import { SignalStatic } from "@/components/brand/SignalStatic";
import { TerminalProgress } from "@/components/brand/TerminalProgress";
import { markBootPainted } from "@/lib/bootGate";
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
 * The overlay reads as jacking in: the wordmark's tagline slot carries a
 * "jacking in" prompt (flipping to "jacked in" as the gate lifts), under
 * {@link SignalStatic} — dead-channel interference whose strength is bound to
 * the real sync, dropping a step each time a phase resolves and cutting out
 * when the link is up. The static skips rendering under
 * prefers-reduced-motion; the caret is covered by
 * {@link ArmadaCrestKeyframes}' rule.
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
  const [leaving, setLeaving] = useState(false);

  // Interference level for the static: buried at first contact, stepping down
  // with every phase of the real sync that resolves, gone once the link is up.
  const resolvedCount = log.filter((line) => line.status !== undefined).length;
  const staticLevel = done ? 0 : Math.max(0.1, 0.5 * 0.72 ** resolvedCount);

  // Fingerprint of live wire activity — changes on every log mutation (a
  // phase resolving, a warmup x/y tick), each of which is a real relay
  // round-trip. SignalStatic ripples on each change.
  const wireSignal = log.map((line) => `${line.id}:${line.status ?? ""}`).join("|");

  useEffect(() => {
    setGateActive(true);
    // A fresh login has no local data for a first paint — the initial sync IS
    // the boot. Open the boot gate so the deferred ingest drivers mount now.
    markBootPainted();
    return () => setGateActive(false);
  }, []);

  // When the sync finishes, hold a brief beat so the final line lands, then
  // fade the whole overlay out before unmounting — the app underneath (often
  // the DMs page with its decrypt prompt) should be arrived at, not cut to.
  // Pointer events drop the moment the fade starts.
  useEffect(() => {
    if (!done) return;
    const beat = setTimeout(() => setLeaving(true), 400);
    const unmount = setTimeout(onDone, 1000);
    return () => {
      clearTimeout(beat);
      clearTimeout(unmount);
    };
  }, [done, onDone]);

  // The fade IS the app becoming interactive, so the gate must read as down
  // the moment it starts — the deferred post-login steps (the DMs decrypt
  // prompt among them) queue behind useSyncGateActive and would otherwise
  // wait out the unmount timer too.
  useEffect(() => {
    if (leaving) setGateActive(false);
  }, [leaving]);

  return (
    <div
      className={`fixed inset-0 z-[100] flex flex-col items-center justify-center gap-10 overflow-hidden bg-background px-6 transition-opacity duration-500 ${
        leaving ? "pointer-events-none opacity-0" : "opacity-100"
      }`}
      role="status"
      aria-live="polite"
    >
      <div className="flex flex-col items-center gap-6">
        <ArmadaCrest size={96} />
        <BrandMark
          tagline={done ? "jacked in" : (
            // A CSS typewriter: width in ch stepped one glyph at a time (the
            // font is mono, so 1ch = 1 glyph), on a slow type/hold/erase loop.
            // BrandMark's caret sits right after this span, so it rides the
            // typed edge. Under reduced motion the animation is killed and the
            // span falls back to its natural (full) width.
            <span className="inline-block overflow-hidden whitespace-nowrap align-bottom animate-[armada-type_7s_steps(10,end)_infinite]">
              jacking in
            </span>
          )}
        />
      </div>

      <div className="w-full max-w-sm">
        <TerminalProgress lines={log} />
      </div>

      {/* Over the content, visor-fashion: the interference is between the
          operator and the feed, not scenery behind it. */}
      <SignalStatic level={staticLevel} seed={pubkey} signal={wireSignal} />

      <ArmadaCrestKeyframes />
      {/* Gate-only keyframes ("jacking in" is 10ch). Type over ~2s, hold,
          erase quickly, breathe, retype. */}
      <style>{`
        @keyframes armada-type {
          0% { width: 0ch; }
          30%, 82% { width: 10ch; }
          94%, 100% { width: 0ch; }
        }
      `}</style>
    </div>
  );
}

export default SyncGate;
