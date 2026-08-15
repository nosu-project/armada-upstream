import { lazy, Suspense, useCallback, useEffect, useMemo, useRef, useState } from "react";

import { FloatingCallStage } from "@/components/chat/FloatingCallStage";
import { MobileCallPreview } from "@/components/chat/MobileCallPreview";
import { useCallForegroundService } from "@/hooks/useCallForegroundService";
import { useCurrentUser } from "@/hooks/useCurrentUser";
import {
  CallContext,
  type ActiveCall,
  type CallSummary,
  type ConcordVoiceContext,
  type DmVoiceContext,
} from "@/contexts/CallContext";
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
  // The floating window's DOM host, registered by FloatingCallStage (desktop)
  // or MobileCallPreview (mobile) when a floating destination is shown. Kept
  // separate from the normal top-of-chat slots so the reparent effect can
  // prefer a normal slot over the floating one. Tracked per variant so a
  // breakpoint transition (both components are mounted; each registers/clears
  // its own host on the same tick) can't have one variant's cleanup clobber the
  // other's registration — only whichever variant currently holds a host is
  // used, and exactly one ever does (each host gates itself on the `sidebar`
  // breakpoint). `floatingVariant` records which is active, so the stage's
  // floating branch can adapt its chrome (desktop shows the media controls;
  // mobile defers them to MobileCallBar).
  const [floatingHosts, setFloatingHosts] = useState<{
    desktop: HTMLElement | null;
    mobile: HTMLElement | null;
  }>({ desktop: null, mobile: null });
  const floatingSlot = floatingHosts.desktop ?? floatingHosts.mobile;
  const floatingVariant: "desktop" | "mobile" | null = floatingHosts.desktop
    ? "desktop"
    : floatingHosts.mobile
      ? "mobile"
      : null;
  const [stageOpen, setStageOpen] = useState(false);
  // The fixed mobile call bar's measured height (incl. bottom safe area),
  // reported by MobileCallBar. The mobile preview positions above the bar off
  // this shared value so its placement never depends on CSS-variable
  // inheritance, and re-evaluates whenever the bar resizes (keyboard, roster,
  // orientation). 0 when the bar isn't mounted.
  const [callBarHeight, setCallBarHeightState] = useState(0);
  const setCallBarHeight = useCallback((px: number) => {
    setCallBarHeightState((prev) => (prev === px ? prev : px));
  }, []);
  // The user dismissed the floating video window (without leaving the call).
  // While true the stage parks off-DOM instead of floating.
  const [floatingHidden, setFloatingHidden] = useState(false);
  // Navigate-to-call handler, registered by the connected voice room (which
  // owns the correct route for its call type). Powers the floating window's
  // "return to call" action.
  const [focusActiveCall, setFocusActiveCall] = useState<(() => void) | null>(null);
  // How the call is labelled outside the app (the Android ongoing-call
  // notification), registered by the connected room — which is the only place
  // that knows the room's name. Resolves a beat after the join, and again as
  // late metadata lands.
  const [callSummary, setCallSummary] = useState<CallSummary | null>(null);
  // Live speaker set (pubkeys), reported by the connected room so voice
  // activity can render outside the LiveKit context (sidebar rosters).
  const [speakingPubkeys, setSpeakingState] = useState<ReadonlySet<string>>(NO_SPEAKERS);
  // Live muted set (pubkeys), reported by the connected room so the sidebar
  // roster can show who has their mic off.
  const [mutedPubkeys, setMutedState] = useState<ReadonlySet<string>>(NO_SPEAKERS);
  // Live raised-hand set (pubkeys), reported by a connected Concord room so the
  // sidebar roster can show who has their hand up (empty in NIP-29/DM calls).
  const [raisedHands, setRaisedHandsState] = useState<ReadonlySet<string>>(NO_SPEAKERS);
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
    // Open the call stage on join so the panel is visible without a manual
    // "Show" click (a screenshare/camera appearing keeps it open too).
    setStageOpen(true);
    setActiveCall({ relayUrl, groupId });
  }, []);

  const joinDmCall = useCallback((ctx: DmVoiceContext) => {
    if (exitTimer.current) {
      clearTimeout(exitTimer.current);
      exitTimer.current = null;
    }
    setExiting(false);
    setStageOpen(true);
    // relayUrl/groupId are display/remount coordinates (the remount key is
    // `${relayUrl}|${groupId}`), so a new call to the same peer — a new call
    // id — rebuilds the room and remints against the new secret.
    setActiveCall({ relayUrl: ctx.broker, groupId: ctx.callId, dmPeer: ctx.peer, dm: ctx });
  }, []);

  const joinConcordCall = useCallback((ctx: ConcordVoiceContext) => {
    if (exitTimer.current) {
      clearTimeout(exitTimer.current);
      exitTimer.current = null;
    }
    setExiting(false);
    setStageOpen(true);
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
    setFloatingHidden(false);
    setSpeakingState(NO_SPEAKERS);
    setMutedState(NO_SPEAKERS);
    setRaisedHandsState(NO_SPEAKERS);
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

  // The floating window registers its host here (only while it's shown — see
  // FloatingCallStage / MobileCallPreview). Separate from the normal
  // top-of-chat slots so the reparent effect below can always prefer a normal
  // slot when one exists. Stored under its variant key so each destination
  // manages its own registration independently (see `floatingHosts`).
  const registerFloatingSlot = useCallback(
    (el: HTMLElement | null, variant: "desktop" | "mobile" = "desktop") => {
      setFloatingHosts((prev) => (prev[variant] === el ? prev : { ...prev, [variant]: el }));
    },
    [],
  );

  const registerFocusActiveCall = useCallback((fn: (() => void) | null) => {
    // Wrap in an updater's stable box: storing a function in state needs the
    // functional form (React would otherwise call it as an updater).
    setFocusActiveCall(() => fn);
  }, []);

  // Value-guarded: the room re-registers on every render of its label inputs,
  // and an unguarded set would re-post the OS notification each time.
  const registerCallSummary = useCallback((summary: CallSummary | null) => {
    setCallSummary((prev) =>
      prev?.title === summary?.title && prev?.subtitle === summary?.subtitle ? prev : summary,
    );
  }, []);

  // Android: the ongoing-call notification, and with it the foreground state
  // that keeps a backgrounded call connected and audible. Driven off the call's
  // whole lifetime — `exiting` included, so the notification outlives the
  // slide-out animation exactly as the LiveKit connection does.
  useCallForegroundService(Boolean(user && activeCall), callSummary, leaveCall);

  const hasNormalSlot = stageSlots.length > 0;

  // Returning to the call's own channel (a normal slot appears) clears any
  // prior floating-window dismissal, so navigating away again re-floats the
  // video rather than staying hidden from a stale decision.
  useEffect(() => {
    if (hasNormalSlot) setFloatingHidden(false);
  }, [hasNormalSlot]);

  // A stable, call-lifetime host element for the call stage. The stage portals
  // into THIS element for the whole call; the element itself is *reparented*
  // into whichever destination is currently active — a normal top-of-chat slot
  // when the user is on the call's channel, the compact floating window when
  // they've navigated away (desktop), or parked detached (mobile, or the user
  // hid the floating window). Reparenting — instead of portaling into each slot
  // directly — keeps CallStage mounted across navigation, so video
  // subscriptions, the focused tile, theater mode, and the screenshare-appeared
  // tracking all survive leaving the room UI (a remount used to pause remote
  // video via adaptiveStream and drop it entirely on the E2EE Concord path).
  const stageHost = useMemo(() => {
    const el = document.createElement("div");
    el.style.display = "contents";
    return el;
  }, []);

  // Reparent destination, in priority order: a registered normal slot (the
  // call's channel is on screen) always wins, so the full stage and the
  // floating window can never show at once; otherwise the floating window's
  // host (when shown); otherwise null → parked off-DOM.
  const stageTarget = hasNormalSlot ? stageSlots[stageSlots.length - 1] : floatingSlot;

  useEffect(() => {
    if (stageTarget) {
      stageTarget.appendChild(stageHost);
      // Browsers pause media elements while they're removed from the document
      // (which happens above whenever the user navigates away from the call's
      // channel, or parks between destinations). Re-inserting the host does NOT
      // resume them, and LiveKit only calls play() on a fresh attach or a tab
      // visibility change — neither happens here since CallStage stays mounted.
      // Without this kick, remote video stays frozen on its last frame after
      // switching channels and back, or after moving to/from the floating
      // window (audio is unaffected: its elements live outside the host).
      for (const video of stageHost.querySelectorAll("video")) {
        if (video.paused) video.play().catch(() => {});
      }
    } else {
      stageHost.remove();
    }
  }, [stageTarget, stageHost]);
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

  // Equality-guarded so the Concord room's presence-fold reports only re-render
  // context consumers when the raised-hand set actually changed.
  const setRaisedHands = useCallback((next: Set<string>) => {
    setRaisedHandsState((prev) => (sameSet(prev, next) ? prev : next));
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

  // The floating destination is shown while: a call is active, its channel
  // isn't on screen (no normal slot), the user hasn't hidden it, and the call
  // isn't exiting. Which destination actually mounts — the draggable desktop
  // window or the compact mobile preview — is decided by each component's own
  // responsive CSS (they register their host only at, respectively, sidebar
  // width and below it), so exactly one is ever present.
  const showFloating = Boolean(user && activeCall) && !hasNormalSlot && !floatingHidden && !exiting;
  const stageFloating = showFloating && floatingSlot !== null;

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
        stageFloating,
        floatingVariant,
        callBarHeight,
        setCallBarHeight,
        floatingHidden,
        setFloatingHidden,
        focusActiveCall,
        registerFocusActiveCall,
        registerCallSummary,
        speakingPubkeys,
        setSpeakingPubkeys,
        mutedPubkeys,
        setMutedPubkeys,
        raisedHands,
        setRaisedHands,
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
                Concord: also on an epoch roll or a refounding). Keyed on the
                voice room pubkey, which is the SFU room name and the token's
                grant identity — it changes on any epoch roll AND on a refounding
                that reuses an epoch number, so the mint/remount stays in step
                with the token the SFU will accept. */}
            <PersistentVoiceRoom
              key={
                activeCall.concord
                  ? `concord|${activeCall.concord.channel.idHex}|${activeCall.concord.channel.voice.room.pk}|${activeCall.concord.broker}`
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
        {/* The compact floating video destinations, shown while the call's
            channel is off screen and the window isn't hidden. Both are rendered
            together but only ONE registers its host at a time — FloatingCallStage
            at sidebar-width (the draggable desktop window), MobileCallPreview
            below it (the fixed above-the-call-bar preview). CallProvider
            reparents the persistent stage host into whichever registered, so the
            same stage — and its media — moves in without any remount or a second
            LiveKit connection. */}
        {showFloating && (
          <>
            <FloatingCallStage
              registerSlot={registerFloatingSlot}
              onExpand={focusActiveCall ?? undefined}
              onHide={() => setFloatingHidden(true)}
            />
            <MobileCallPreview
              registerSlot={registerFloatingSlot}
              onExpand={focusActiveCall ?? undefined}
              onHide={() => setFloatingHidden(true)}
            />
          </>
        )}
      </div>
    </CallContext.Provider>
  );
}
