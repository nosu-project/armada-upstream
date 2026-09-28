import { useEffect, useState } from "react";

import { ArmadaCrest, ArmadaCrestKeyframes } from "@/components/brand/ArmadaCrest";
import { BrandMark } from "@/components/brand/BrandMark";
import { SignalStatic } from "@/components/brand/SignalStatic";
import { TerminalProgress } from "@/components/brand/TerminalProgress";
import { markBootPainted } from "@/lib/bootGate";
import { setSyncGateActive } from "@/components/syncGateState";
import { useFreshLogin } from "@/hooks/useFreshLogin";
import { useInitialSync } from "@/hooks/useInitialSync";

/**
 * Full-screen overlay after a *fresh* login ({@link useFreshLogin}) until
 * {@link useInitialSync} is done, so the app doesn't flash empty channels and
 * the default theme. Timeout-bounded; static skips under reduced motion.
 */
export function SyncGate() {
  const { freshPubkey, acknowledge } = useFreshLogin();
  if (!freshPubkey) return null;
  return <SyncOverlay pubkey={freshPubkey} onDone={acknowledge} />;
}

function SyncOverlay({ pubkey, onDone }: { pubkey: string; onDone: () => void }) {
  const { log, done } = useInitialSync(pubkey);
  const [leaving, setLeaving] = useState(false);

  // Static strength steps down with each resolved phase.
  const resolvedCount = log.filter((line) => line.status !== undefined).length;
  const staticLevel = done ? 0 : Math.max(0.1, 0.5 * 0.72 ** resolvedCount);

  // Changes on every log mutation (each a real relay round-trip); SignalStatic ripples on it.
  const wireSignal = log.map((line) => `${line.id}:${line.status ?? ""}`).join("|");

  useEffect(() => {
    setSyncGateActive(true);
    // A fresh login has no local data to paint: the sync IS the boot.
    markBootPainted();
    return () => setSyncGateActive(false);
  }, []);

  // Hold a beat for the final line, then fade out before unmounting.
  useEffect(() => {
    if (!done) return;
    const beat = setTimeout(() => setLeaving(true), 400);
    const unmount = setTimeout(onDone, 1000);
    return () => {
      clearTimeout(beat);
      clearTimeout(unmount);
    };
  }, [done, onDone]);

  // The gate reads down as soon as the fade starts, so queued post-login steps don't wait for unmount.
  useEffect(() => {
    if (leaving) setSyncGateActive(false);
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
        <ArmadaCrest size={96} loop />
        <BrandMark
          tagline={done ? "jacked in" : (
            // CSS typewriter: width in ch (mono font) stepped per glyph.
            <span className="inline-block overflow-hidden whitespace-nowrap align-bottom animate-[armada-type_7s_steps(10,end)_infinite]">
              jacking in
            </span>
          )}
        />
      </div>

      <div className="w-full max-w-sm">
        <TerminalProgress lines={log} />
      </div>

      <SignalStatic level={staticLevel} seed={pubkey} signal={wireSignal} />

      <ArmadaCrestKeyframes />
      {/* "jacking in" is 10ch. */}
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
