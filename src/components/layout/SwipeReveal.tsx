import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";

import { useAndroidBack } from "@/hooks/useAndroidBack";
import { useEdgeSwipe } from "@/hooks/useEdgeSwipe";
import { useIsTouch } from "@/hooks/useIsMobile";
import { onAppStateChange } from "@/lib/appStateEvents";
import { isRecentDeepLinkNavigation } from "@/lib/deepLinkNav";
import { cn } from "@/lib/utils";

/** Settle/enter transition length (ms). Matches the `duration-200` classes. */
const SETTLE_MS = 200;

/** Parallax shift of the underlay at full cover (% of its own width). */
const UNDERLAY_SHIFT_PCT = 18;

/**
 * Hard deadline for removing the mount slide-in keyframe class. A RUNNING CSS
 * animation outranks inline style in the cascade, so every corrective
 * `style.transform` write this component makes is silently overridden while
 * the keyframe is live — and the Android WebView can freeze the animation
 * timeline across a background/resume transition (the same defect MainActivity
 * documents for visibility), pinning the pane at a mid-slide frame that no
 * later write can move. Timers survive that freeze (resumeTimers un-freezes
 * them), so a timeout is the reliable way to guarantee the class comes off;
 * `animationend` handles the normal case sooner.
 */
const ENTER_ANIM_MAX_MS = 600;

/**
 * How long a committed gesture's optimistic `pendingOpen` may wait for the
 * `open` prop to catch up before it is abandoned. Normally the deferred
 * navigation flips the prop within a frame or two; if the commit callback was
 * lost (see `deferCommit`), pendingOpen alone would otherwise hold
 * `pointer-events-none` on a pane that is still visually covering the screen —
 * the frozen-taps state — forever.
 */
const PENDING_OPEN_MAX_MS = 1000;

/** setTimeout backstop for `deferCommit`'s rAF chain (see there). */
const COMMIT_FALLBACK_MS = 80;

interface SwipeRevealProps {
  /**
   * The persistent parent view (server rail + channel/DM list) revealed
   * underneath the chat when swiping. On desktop these are the static left
   * panes.
   */
  underlay: React.ReactNode;
  /** The chat pane (a full-height column). It slides right to reveal `underlay`. */
  children: React.ReactNode;
  /**
   * Whether the list is revealed (chat slid fully away). Controlled by the
   * parent so the reveal persists until a channel is tapped or the chat is
   * swiped/tapped back.
   */
  open: boolean;
  /** Reveal the list (chat slides fully out). */
  onReveal: () => void;
  /** Slide the chat back over the list. */
  onClose: () => void;
}

/**
 * Discord-style swipe-to-reveal layout for the mobile chat screens. The chat
 * pane is a full-screen overlay:
 *
 * - Drag rightward from anywhere on the chat pane → the chat slides right;
 *   release past the threshold and it slides fully out, revealing the list
 *   (`onReveal`). On Android the system back gesture is the reliable way to
 *   start a reveal, since the OS reserves the screen edges for its own nav.
 * - When revealed, drag the list left (or tap the chat-return affordance) →
 *   the chat slides back (`onClose`).
 *
 * A cancelled drag springs back. On desktop / non-touch it degrades to a plain
 * side-by-side flex row.
 *
 * Two things keep the gesture off the main-thread hot path:
 *
 * - The live drag position is written straight onto the panes' `style` in a
 *   rAF (see `applyDrag`), never through React state — a render per
 *   pointermove would put the whole page tree between the finger and the
 *   frame.
 * - A committed gesture settles OPTIMISTICALLY (`pendingOpen`) and the
 *   navigation that makes it real is deferred until the settle transition has
 *   started on the compositor (`deferCommit`). Calling `onReveal` synchronously
 *   in the pointerup handler put the route change's re-render — the entire
 *   destination view — on the exact frame the settle had to start from, which
 *   is what made releasing the swipe visibly hitch.
 */
export function SwipeReveal({ underlay, children, open, onReveal, onClose }: SwipeRevealProps) {
  const isTouch = useIsTouch();
  // Mobile layout (single-pane drill-down) kicks in below the 900px `sidebar:`
  // breakpoint. Gate the gesture on a narrow viewport AND a touch device so a
  // small desktop window keeps the side-by-side panes.
  const [narrow, setNarrow] = useState(
    () => window.matchMedia("(max-width: 899px)").matches,
  );
  useEffect(() => {
    const mql = window.matchMedia("(max-width: 899px)");
    const onChange = () => setNarrow(mql.matches);
    mql.addEventListener("change", onChange);
    setNarrow(mql.matches);
    return () => mql.removeEventListener("change", onChange);
  }, []);

  const swipeEnabled = isTouch && narrow;

  // A committed gesture's optimistic resting state, applied on the release
  // frame; `null` whenever the `open` prop is authoritative. Cleared the
  // moment the prop catches up (or a navigation overrides it).
  const [pendingOpen, setPendingOpen] = useState<boolean | null>(null);
  const effectiveOpen = pendingOpen ?? open;

  const paneRef = useRef<HTMLDivElement>(null);
  const underlayRef = useRef<HTMLDivElement>(null);

  // Direct, rAF-coalesced drag writes. Coalescing matters on displays whose
  // touch sampling outruns the frame rate; the write itself is two compositor
  // properties on already-promoted layers.
  const dragRaf = useRef<number | null>(null);
  const pendingDragOffset = useRef(0);
  const applyDrag = useCallback((offset: number) => {
    pendingDragOffset.current = offset;
    if (dragRaf.current !== null) return;
    dragRaf.current = requestAnimationFrame(() => {
      dragRaf.current = null;
      const width = window.innerWidth || 1;
      const off = Math.max(0, Math.min(pendingDragOffset.current, width));
      const progress = off / width;
      if (paneRef.current) {
        paneRef.current.style.transform = `translate3d(${off}px, 0, 0)`;
      }
      if (underlayRef.current) {
        underlayRef.current.style.transform =
          `translateX(${-(1 - progress) * UNDERLAY_SHIFT_PCT}%)`;
      }
    });
  }, []);
  useEffect(() => () => {
    if (dragRaf.current !== null) cancelAnimationFrame(dragRaf.current);
  }, []);

  // Latest navigation callbacks for the deferred commit below.
  const onRevealRef = useRef(onReveal);
  onRevealRef.current = onReveal;
  const onCloseRef = useRef(onClose);
  onCloseRef.current = onClose;

  // Run the navigation callback once the settle transition is underway: the
  // first frame paints the new resting transform (the CSS transition starts
  // and is owned by the compositor from then on), the second hands the main
  // thread to the navigation render, which can now overrun a frame budget
  // without stuttering the slide.
  //
  // The rAF chain carries a real hazard on Android: the WebView can stop
  // servicing rAF across a background/resume transition while timers keep
  // running, and a commit parked on a dead rAF strands `pendingOpen` — the
  // pane is `pointer-events-none` (React thinks it revealed) but the
  // navigation that would make that true never runs, which reads as the whole
  // screen ignoring touches. The setTimeout backstop guarantees the callback
  // by the means that provably survives those transitions; whichever fires
  // first wins.
  const commitRaf = useRef<number | null>(null);
  const commitTimeout = useRef<number | null>(null);
  const clearCommitSchedules = useCallback(() => {
    if (commitRaf.current !== null) {
      cancelAnimationFrame(commitRaf.current);
      commitRaf.current = null;
    }
    if (commitTimeout.current !== null) {
      window.clearTimeout(commitTimeout.current);
      commitTimeout.current = null;
    }
  }, []);
  const deferCommit = useCallback((fn: () => void) => {
    clearCommitSchedules();
    const run = () => {
      clearCommitSchedules();
      fn();
    };
    commitRaf.current = requestAnimationFrame(() => {
      commitRaf.current = requestAnimationFrame(() => {
        commitRaf.current = null;
        run();
      });
    });
    commitTimeout.current = window.setTimeout(run, COMMIT_FALLBACK_MS);
  }, [clearCommitSchedules]);
  useEffect(() => () => clearCommitSchedules(), [clearCommitSchedules]);

  // A gesture-driven reveal/close should animate to its resting position (the
  // Discord settle). An `open` change from *navigation* (switching
  // server/community reuses this page instance and flips `open` via a route
  // effect) must NOT animate — otherwise the chat pane visibly slides across the
  // screen ("dives into a channel") before landing on the channel list, which
  // reads as a glitch. We flag the next `open` change as gesture-driven when a
  // swipe commits, and snap (no transition) for every other `open` change.
  const gestureCommit = useRef(false);
  const commitReveal = useCallback(() => {
    gestureCommit.current = true;
    setPendingOpen(true);
    deferCommit(() => onRevealRef.current());
  }, [deferCommit]);
  const commitClose = useCallback(() => {
    gestureCommit.current = true;
    setPendingOpen(false);
    deferCommit(() => onCloseRef.current());
  }, [deferCommit]);

  // Android system back gesture / button. On the mobile drill-down, when the
  // chat is showing (list hidden), "back" reveals the channel list — one level
  // up, the Discord behavior. This is also the only reliable left-edge gesture
  // on Android, where the OS reserves the screen edges for its own gesture nav
  // and eats an in-WebView edge swipe before our pointer handlers see it. When
  // the list is already revealed, we defer (return false) so back leaves the
  // server/community via normal history navigation. Routed through the same
  // committed-gesture path as a swipe, so it animates the settle and keeps the
  // navigation render off the release frame.
  useAndroidBack(() => {
    if (!effectiveOpen) {
      commitReveal();
      return true;
    }
    return false;
  }, swipeEnabled);

  // Slide the chat in from the right on first mount (e.g. tapping a channel on
  // ServerPage navigates here as a *fresh* component, so without this the chat
  // would just appear flush with no animation). A one-shot CSS keyframe
  // (`animate-in`) runs on the compositor independently of React/main-thread
  // work, so the heavy chat tree mounting on the same frame doesn't stutter it
  // (the old rAF approach forced an extra render + reflow and lurched). Captured
  // once on mount; never re-armed. Only when entering closed on a touch layout —
  // and not for a deep-link arrival (notification tap, App Link), which should
  // LAND on its destination when the native crest gate/splash lifts, not play
  // one more transition after it.
  const [enterAnim, setEnterAnim] = useState(() => swipeEnabled && !open && !isRecentDeepLinkNavigation());

  // Remove the keyframe class once the slide-in has played. Leaving it on is
  // not cosmetic debt: a keyframe animation outranks inline style, so a wedged
  // animation timeline (see ENTER_ANIM_MAX_MS) pins the pane at a mid-slide
  // frame that the at-rest transform reconciliation below cannot override.
  // `animationend` is the normal path; the timeout is the one that still fires
  // after a background/resume cut the animation short.
  useEffect(() => {
    if (!enterAnim) return;
    const id = window.setTimeout(() => setEnterAnim(false), ENTER_ANIM_MAX_MS);
    return () => window.clearTimeout(id);
  }, [enterAnim]);

  // Opening: rightward drag from the left edge of the chat (only when closed).
  const openSwipe = useEdgeSwipe({
    enabled: swipeEnabled && !effectiveOpen,
    direction: "open",
    onCommit: commitReveal,
    onDragMove: applyDrag,
  });
  // Closing: leftward drag on the revealed list (only when open).
  const closeSwipe = useEdgeSwipe({
    enabled: swipeEnabled && effectiveOpen,
    direction: "close",
    onCommit: commitClose,
    onDragMove: useCallback(
      (dragX: number) => applyDrag((window.innerWidth || 1) - dragX),
      [applyDrag],
    ),
  });

  // Suppress the transform transition for one render whenever `open` flips
  // without a preceding gesture commit (i.e. navigation). `useLayoutEffect` runs
  // before paint so the snap applies on the same frame the new `open` lands.
  const prevOpen = useRef(open);
  const [snap, setSnap] = useState(false);
  const cancelOpenSwipe = openSwipe.cancel;
  const cancelCloseSwipe = closeSwipe.cancel;
  useLayoutEffect(() => {
    if (prevOpen.current !== open) {
      setSnap(!gestureCommit.current);
      prevOpen.current = open;
      // A programmatic `open` change (navigation) is authoritative: abandon any
      // drag still in flight so the pane settles at the position navigation
      // asked for. A committing gesture has already reset itself before firing
      // onReveal/onClose, so this is a no-op on that path.
      cancelOpenSwipe();
      cancelCloseSwipe();
      // The prop caught up with (or overrode) any optimistic commit state.
      setPendingOpen(null);
    }
    gestureCommit.current = false;
  }, [open, cancelOpenSwipe, cancelCloseSwipe]);
  // Re-enable transitions on the next frame after a snap so subsequent gestures
  // still animate their settle.
  useEffect(() => {
    if (!snap) return;
    const id = requestAnimationFrame(() => setSnap(false));
    return () => cancelAnimationFrame(id);
  }, [snap]);

  // Spring `pendingOpen` back to the prop's truth if the deferred navigation
  // never lands. The optimistic state exists to bridge two frames; if the
  // `open` prop hasn't caught up in PENDING_OPEN_MAX_MS the commit was lost,
  // and holding pendingOpen would hold `pointer-events-none` on a pane the
  // user is looking at (and tapping).
  useEffect(() => {
    if (pendingOpen === null || pendingOpen === open) return;
    const id = window.setTimeout(() => setPendingOpen(null), PENDING_OPEN_MAX_MS);
    return () => window.clearTimeout(id);
  }, [pendingOpen, open]);

  // Resume reconciliation. A background/resume transition is the one moment
  // this component's DOM can diverge from its React state — a cut touch
  // stream, a frozen rAF, a wedged keyframe timeline — and Capacitor's
  // `appStateChange` is the signal that reliably fires on it (the renderer's
  // own visibility events don't, per App.tsx). Drop every transient the drag
  // machinery holds and force a commit, so the at-rest layout effect below
  // rewrites the transforms from the prop truth on the next frame the user
  // sees.
  const [, bumpResync] = useState(0);
  useEffect(() => {
    if (!swipeEnabled) return;
    return onAppStateChange((active) => {
      if (!active) return;
      cancelOpenSwipe();
      cancelCloseSwipe();
      setPendingOpen(null);
      setEnterAnim(false);
      // The clears above may all be no-ops on an already-consistent tree;
      // bump unconditionally so the reconciling commit still happens.
      bumpResync((n) => n + 1);
    });
  }, [swipeEnabled, cancelOpenSwipe, cancelCloseSwipe]);

  // Whether the chat pane is currently in motion: a live drag, the settle
  // transition after one, or the mount slide-in. This gates `will-change`
  // (see the pane's style below) — the hint is only meaningful while the
  // element actually moves, and leaving it set pins a compositor layer.
  // Promotion lands on the frame the drag is claimed (10px in) rather than at
  // pointerdown, so the very first drag frame pays for the layer; tracking
  // pointerdown instead would re-render on every tap of the chat pane.
  const [moving, setMoving] = useState(() => enterAnim);
  const firstMotion = useRef(true);
  useEffect(() => {
    // Skip the mount pass — `moving` is already seeded from `enterAnim`.
    if (firstMotion.current) {
      firstMotion.current = false;
      return;
    }
    setMoving(true);
  }, [effectiveOpen, openSwipe.dragging, closeSwipe.dragging]);
  useEffect(() => {
    if (!moving || openSwipe.dragging || closeSwipe.dragging) return;
    const id = window.setTimeout(() => setMoving(false), SETTLE_MS);
    return () => window.clearTimeout(id);
  }, [moving, openSwipe.dragging, closeSwipe.dragging]);

  const width = typeof window !== "undefined" ? window.innerWidth : 1;
  // Only a drag that pulls the pane AWAY from its current resting position can
  // drive the offset: "open" drags the chat off a closed pane, "close" drags it
  // back over an open one. Pairing each with the `open` it started from means a
  // drag left over from before an `open` flip is inert rather than authoritative
  // — the pane follows navigation instead of being pinned mid-slide by a gesture
  // that can no longer end (the stuck sliver-of-channel-list state).
  const openDragging = openSwipe.dragging && !effectiveOpen;
  const closeDragging = closeSwipe.dragging && effectiveOpen;
  // Chat resting offset: fully out (= width) when revealed, else flush (0).
  // Live drags add/subtract from that rest position (read from the gesture's
  // ref, so a render that happens mid-drag paints the current position).
  let offset: number;
  if (openDragging) {
    offset = openSwipe.dragXRef.current; // 0 → width as it slides out
  } else if (closeDragging) {
    offset = width - closeSwipe.dragXRef.current; // width → 0 as it slides back
  } else {
    offset = effectiveOpen ? width : 0;
  }
  offset = Math.max(0, Math.min(offset, width));
  const dragging = openDragging || closeDragging;

  const progress = width > 0 ? offset / width : 0;
  // Parallax the underlay in from the left (Discord slides the list slightly
  // rather than holding it static).
  const underlayShift = -(1 - progress) * UNDERLAY_SHIFT_PCT;

  // At rest, make the rendered position authoritative in the DOM. The drag
  // writes transforms imperatively, so React's style prop can hold a stale
  // value it would skip re-writing on the next render; this runs before paint
  // on every commit and lands the settle target with the transition classes
  // already in place.
  useLayoutEffect(() => {
    if (!swipeEnabled || dragging) return;
    if (dragRaf.current !== null) {
      cancelAnimationFrame(dragRaf.current);
      dragRaf.current = null;
    }
    if (paneRef.current) {
      paneRef.current.style.transform = `translate3d(${offset}px, 0, 0)`;
    }
    if (underlayRef.current) {
      underlayRef.current.style.transform = `translateX(${underlayShift}%)`;
    }
  });

  if (!swipeEnabled) {
    // Desktop: static side-by-side panes.
    return (
      <>
        {underlay}
        {children}
      </>
    );
  }

  return (
    <>
      {/* Underlay: the list, revealed as the chat slides away. While open it
          carries the leftward "close" swipe so you can drag the chat back.
          `contain` isolates its layout/paint so mounting the (heavy) chat tree
          over it doesn't force the underlay to re-layout/repaint. The close
          handlers stay mounted whether or not the list is revealed: the hook
          self-gates on `enabled`, and detaching them mid-gesture (as an `open`
          flip used to do) removed the very pointerup/pointercancel that ends
          the drag, stranding it. */}
      <div
        ref={underlayRef}
        {...closeSwipe.handlers}
        className={cn(
          "absolute inset-0 flex [contain:layout_paint]",
          dragging || snap ? "" : "transition-transform duration-200 ease-out",
          // Reserve the fixed mobile call bar's height (same as the chat overlay
          // below) so it never covers the bottom of the revealed list — notably
          // the server rail's pinned Settings footer. Being `absolute inset-0`,
          // this underlay ignores the shell's padding box, so the reservation
          // has to live here. Unset (no active call) falls back to 0.
          "max-sidebar:pb-[var(--call-bar-h,0px)]",
        )}
        style={{
          transform: `translateX(${underlayShift}%)`,
          touchAction: effectiveOpen ? "pan-y" : undefined,
          // Its transform moves every drag frame in step with the pane's, so it
          // earns the layer for exactly the same window (dropped at rest for
          // the same reason — see the pane below).
          willChange: moving ? "transform" : undefined,
        }}
        aria-hidden={progress === 0}
      >
        {underlay}
      </div>

      {/* Chat pane overlay. Slides right by the live drag (or rest) offset;
          springs to its rest position with a transition when not dragging. A
          fresh mount slides in from the right via a one-shot CSS keyframe.
          `translateZ` keeps the offset on the compositor, and `will-change`
          promotes the pane to its own layer *while it moves* so the slide runs
          on the compositor thread instead of repainting per frame. The hint is
          dropped at rest: this pane is viewport-sized and mounted on every
          mobile route for the whole session, so a permanent `will-change`
          retains a full-screen layer indefinitely — the exact misuse the
          property is documented against. `contain` keeps the chat tree's mount
          from invalidating the rest of the page. */}
      <div
        ref={paneRef}
        {...openSwipe.handlers}
        // The slide-in keyframe has played out — drop the class (see the
        // enterAnim effect for why it must not linger). Scoped to the pane's
        // own animation; children's animations bubble through here too.
        onAnimationEnd={(e) => {
          if (enterAnim && e.target === e.currentTarget) setEnterAnim(false);
        }}
        className={cn(
          "absolute inset-0 z-10 flex flex-col bg-background shadow-2xl [contain:layout_paint]",
          dragging || snap ? "" : "transition-transform duration-200 ease-out",
          enterAnim && "animate-in slide-in-from-right duration-200 ease-out",
          // Reserve the fixed mobile call bar's measured height (set on the
          // shell as --call-bar-h while a call is active) so it never covers the
          // composer. The shell's own padding can't do this — this overlay is
          // `absolute inset-0`, so it ignores the shell's padding box. Unset
          // (no active call) falls back to 0.
          "max-sidebar:pb-[var(--call-bar-h,0px)]",
          // When fully revealed the chat is off-screen — don't let it block the
          // list's taps/gestures underneath. Keyed on the OPTIMISTIC state so a
          // committed reveal frees the list for taps on the release frame, not
          // after the deferred navigation lands.
          effectiveOpen && !dragging && "pointer-events-none",
        )}
        style={{
          transform: `translate3d(${offset}px, 0, 0)`,
          touchAction: "pan-y",
          willChange: moving ? "transform" : undefined,
        }}
      >
        {children}
      </div>
    </>
  );
}
