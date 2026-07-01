import { lazy, Suspense, useCallback, useEffect, useRef, useState } from "react";

import { useCurrentUser } from "@/hooks/useCurrentUser";
import { CallContext, type ActiveCall, type ConcordVoiceContext } from "@/contexts/CallContext";
import { cn } from "@/lib/utils";
import { bytesToHex } from "@noble/hashes/utils.js";

/**
 * The LiveKit half of the stack (the connected room, its bars, E2EE, RNNoise)
 * loads lazily on the first call join. The LiveKit SDK is ~0.5MB of JS that
 * used to sit in the boot bundle costing every cold start parse time; nothing
 * voice-related renders until `activeCall` is set, so nothing voice-related
 * should load until then either.
 */
const PersistentVoiceRoom = lazy(() => import("@/components/PersistentVoiceRoom"));

/**
 * App-level voice call state. Holds the active room and renders the persistent
 * LiveKitRoom so navigation doesn't tear down the call.
 */
export function CallProvider({ children }: { children: React.ReactNode }) {
  const { user } = useCurrentUser();
  const [activeCall, setActiveCall] = useState<ActiveCall | null>(null);
  const [exiting, setExiting] = useState(false);
  const [slots, setSlots] = useState<HTMLElement[]>([]);
  const [stageSlots, setStageSlots] = useState<HTMLElement[]>([]);
  const [stageOpen, setStageOpen] = useState(false);
  const exitTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  // The app shell; the mobile call bar writes its measured height to
  // `--call-bar-h` here so the shell reserves exactly that as bottom padding.
  const shellRef = useRef<HTMLDivElement>(null);

  const joinCall = useCallback((relayUrl: string, groupId: string) => {
    if (exitTimer.current) {
      clearTimeout(exitTimer.current);
      exitTimer.current = null;
    }
    setExiting(false);
    setActiveCall({ relayUrl, groupId });
  }, []);

  const joinDmCall = useCallback((relayUrl: string, roomId: string, peer: string) => {
    if (exitTimer.current) {
      clearTimeout(exitTimer.current);
      exitTimer.current = null;
    }
    setExiting(false);
    setActiveCall({ relayUrl, groupId: roomId, dmPeer: peer });
  }, []);

  const joinConcordCall = useCallback((ctx: ConcordVoiceContext) => {
    if (exitTimer.current) {
      clearTimeout(exitTimer.current);
      exitTimer.current = null;
    }
    setExiting(false);
    // relayUrl/groupId are unused for the Concord path (the broker + room id are
    // derived inside ConcordVoiceRoom); set sentinel values for the remount key.
    setActiveCall({
      relayUrl: ctx.voiceServer,
      groupId: bytesToHex(ctx.channel.id),
      concord: ctx,
    });
  }, []);

  // Trigger the exit animation, then tear down the room once it finishes. The
  // LiveKit connection lives in PersistentVoiceRoom, so we keep it mounted for
  // the brief slide-out before unmounting (which disconnects). The leave chirp
  // is played by the hangup button's onClick (in VoiceBar), inside the user
  // gesture and before teardown — playing it here would be too late and get cut.
  const leaveCall = useCallback(() => {
    setExiting(true);
    setStageOpen(false);
    if (exitTimer.current) clearTimeout(exitTimer.current);
    exitTimer.current = setTimeout(() => {
      setActiveCall(null);
      setExiting(false);
      exitTimer.current = null;
    }, 200);
  }, []);

  useEffect(() => () => {
    if (exitTimer.current) clearTimeout(exitTimer.current);
  }, []);

  const registerCallBarSlot = useCallback((el: HTMLElement) => {
    setSlots((prev) => (prev.includes(el) ? prev : [...prev, el]));
    return () => setSlots((prev) => prev.filter((s) => s !== el));
  }, []);

  const registerCallStageSlot = useCallback((el: HTMLElement) => {
    setStageSlots((prev) => (prev.includes(el) ? prev : [...prev, el]));
    return () => setStageSlots((prev) => prev.filter((s) => s !== el));
  }, []);

  const toggleStage = useCallback(() => setStageOpen((o) => !o), []);

  return (
    <CallContext.Provider
      value={{
        activeCall,
        joinCall,
        joinDmCall,
        joinConcordCall,
        leaveCall,
        registerCallBarSlot,
        registerCallStageSlot,
        stageOpen,
        toggleStage,
        setStageOpen,
      }}
    >
      <div
        ref={shellRef}
        className={cn(
          "relative flex h-full w-full overflow-hidden",
          // On mobile the call bar is a fixed bottom overlay; reserve exactly
          // its measured height (written to --call-bar-h by MobileCallBar) so it
          // never covers the composer and leaves no gap. The fallback covers the
          // first frame before the bar measures itself. On desktop the bar lives
          // in the sidebar slot, so no reservation is needed.
          user && activeCall && "max-sidebar:pb-[var(--call-bar-h,0px)]",
        )}
      >
        {children}
        {user && activeCall && (
          // While the voice chunk streams in there's nothing to show yet — the
          // token request bar appears as soon as the module lands.
          <Suspense fallback={null}>
            {/* `key` remounts the connection only when switching rooms. */}
            <PersistentVoiceRoom
              key={
                activeCall.concord
                  ? `concord|${bytesToHex(activeCall.concord.channel.id)}|${activeCall.concord.channel.epoch}`
                  : `${activeCall.relayUrl}|${activeCall.groupId}`
              }
              call={activeCall}
              onLeave={leaveCall}
              slots={slots}
              stageSlots={stageSlots}
              stageOpen={stageOpen}
              exiting={exiting}
              shellRef={shellRef}
            />
          </Suspense>
        )}
      </div>
    </CallContext.Provider>
  );
}
