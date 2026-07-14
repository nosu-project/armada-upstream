import { lazy, Suspense, useCallback, useEffect, useMemo, useRef, useState } from "react";

import { useCurrentUser } from "@/hooks/useCurrentUser";
import { CallContext, type ActiveCall, type ConcordVoiceContext } from "@/contexts/CallContext";
import { cn } from "@/lib/utils";

/**
 * The LiveKit half of the stack (the connected room, its bars, E2EE, RNNoise)
 * loads lazily on the first call join. The LiveKit SDK is ~0.5MB of JS that
 * used to sit in the boot bundle costing every cold start parse time; nothing
 * voice-related renders until `activeCall` is set, so nothing voice-related
 * should load until then either.
 */
const PersistentVoiceRoom = lazy(() => import("@/components/PersistentVoiceRoom"));

const NO_SPEAKERS: ReadonlySet<string> = new Set();

/** Order-insensitive set equality (speaker sets are tiny). */
function sameSet(a: ReadonlySet<string>, b: ReadonlySet<string>): boolean {
  if (a.size !== b.size) return false;
  for (const v of a) if (!b.has(v)) return false;
  return true;
}

/** Element-wise list equality (rosters are tiny and order-stable). */
function sameList(a: readonly string[], b: readonly string[]): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
  return true;
}

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
  // Live speaker set (pubkeys), reported by the connected room so voice
  // activity can render outside the LiveKit context (sidebar rosters).
  const [speakingPubkeys, setSpeakingState] = useState<ReadonlySet<string>>(NO_SPEAKERS);
  // Live muted set (pubkeys), reported by the connected room so the sidebar
  // roster can show who has their mic off.
  const [mutedPubkeys, setMutedState] = useState<ReadonlySet<string>>(NO_SPEAKERS);
  // Live roster of the connected room (pubkeys), reported by the room so the
  // active call's occupancy renders from LiveKit truth instead of relay
  // presence events (which lag/desync). Null while not connected.
  const [voiceRoomPubkeys, setRosterState] = useState<readonly string[] | null>(null);
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
    // relayUrl/groupId are display/remount coordinates for the Concord path
    // (the room name + token derive inside ConcordVoiceRoom from the channel).
    setActiveCall({ relayUrl: ctx.broker, groupId: ctx.channel.idHex, concord: ctx });
  }, []);

  // Trigger the exit animation, then tear down the room once it finishes. The
  // LiveKit connection lives in PersistentVoiceRoom, so we keep it mounted for
  // the brief slide-out before unmounting (which disconnects). The leave chirp
  // is played by the hangup button's onClick (in VoiceBar), inside the user
  // gesture and before teardown — playing it here would be too late and get cut.
  const leaveCall = useCallback(() => {
    setExiting(true);
    setStageOpen(false);
    setSpeakingState(NO_SPEAKERS);
    setMutedState(NO_SPEAKERS);
    setRosterState(null);
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

  // A stable, call-lifetime host element for the call stage. The stage portals
  // into THIS element for the whole call; the element itself is *reparented*
  // into whichever page slot is currently registered (and parked detached when
  // none is). Reparenting — instead of portaling into each slot directly —
  // keeps CallStage mounted across navigation, so video subscriptions, the
  // focused tile, theater mode, and the screenshare-appeared tracking all
  // survive leaving the room UI (a remount used to pause remote video via
  // adaptiveStream and drop it entirely on the E2EE Concord path).
  const stageHost = useMemo(() => {
    const el = document.createElement("div");
    el.style.display = "contents";
    return el;
  }, []);

  useEffect(() => {
    const target = stageSlots.length > 0 ? stageSlots[stageSlots.length - 1] : null;
    if (target) {
      target.appendChild(stageHost);
      // Browsers pause media elements while they're removed from the document
      // (which happens above whenever the user navigates away from the call's
      // channel). Re-inserting the host does NOT resume them, and LiveKit only
      // calls play() on a fresh attach or a tab visibility change — neither
      // happens here since CallStage stays mounted. Without this kick, remote
      // video stays frozen on its last frame after switching channels and back
      // (audio is unaffected: its elements live outside the reparented host).
      for (const video of stageHost.querySelectorAll("video")) {
        if (video.paused) video.play().catch(() => {});
      }
    } else {
      stageHost.remove();
    }
  }, [stageSlots, stageHost]);
  useEffect(() => () => stageHost.remove(), [stageHost]);

  const toggleStage = useCallback(() => setStageOpen((o) => !o), []);

  // Equality-guarded so the room's frequent ActiveSpeakersChanged reports only
  // re-render context consumers when the speaker set actually changed.
  const setSpeakingPubkeys = useCallback((next: Set<string>) => {
    setSpeakingState((prev) => (sameSet(prev, next) ? prev : next));
  }, []);

  // Equality-guarded so the room's frequent mute reports only re-render context
  // consumers when the muted set actually changed.
  const setMutedPubkeys = useCallback((next: Set<string>) => {
    setMutedState((prev) => (sameSet(prev, next) ? prev : next));
  }, []);

  // Equality-guarded so the room's participant reports only re-render context
  // consumers when the roster actually changed.
  const setVoiceRoomPubkeys = useCallback((next: readonly string[] | null) => {
    setRosterState((prev) => {
      if (prev === next) return prev;
      if (prev && next && sameList(prev, next)) return prev;
      return next;
    });
  }, []);

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
        speakingPubkeys,
        setSpeakingPubkeys,
        mutedPubkeys,
        setMutedPubkeys,
        voiceRoomPubkeys,
        setVoiceRoomPubkeys,
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
            {/* `key` remounts the connection only when switching rooms (for
                Concord: also on an epoch roll or a rendezvous migration). */}
            <PersistentVoiceRoom
              key={
                activeCall.concord
                  ? `concord|${activeCall.concord.channel.idHex}|${activeCall.concord.channel.current.epoch}|${activeCall.concord.broker}`
                  : `${activeCall.relayUrl}|${activeCall.groupId}`
              }
              call={activeCall}
              onLeave={leaveCall}
              slots={slots}
              stageHost={stageHost}
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
