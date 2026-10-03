import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";

import { leaveApp, useAndroidBack } from "@/hooks/useAndroidBack";
import { useEdgeSwipe } from "@/hooks/useEdgeSwipe";
import { useIsTouch } from "@/hooks/useIsMobile";
import { onAppStateChange } from "@/lib/appStateEvents";
import { isRecentDeepLinkNavigation } from "@/lib/deepLinkNav";
import { cn } from "@/lib/utils";

const SETTLE_MS = 200;

/** Parallax shift of the underlay at full cover (% of its own width). */
const UNDERLAY_SHIFT_PCT = 18;

/**
 * Deadline for removing the slide-in keyframe class. A running CSS animation
 * outranks inline style, and Android WebView can freeze the animation timeline
 * across background/resume; timers survive that. `animationend` is the fast path.
 */
const ENTER_ANIM_MAX_MS = 600;

/** Max wait for `open` to catch up with `pendingOpen`; a lost commit would otherwise freeze taps. */
const PENDING_OPEN_MAX_MS = 1000;

const COMMIT_FALLBACK_MS = 80;

interface SwipeRevealProps {
  underlay: React.ReactNode;
  children: React.ReactNode;
  open: boolean;
  onReveal: () => void;
  onClose: () => void;
}

/**
 * Discord-style swipe-to-reveal for mobile chat screens; plain side-by-side on
 * desktop. Drag writes go straight to `style` in a rAF (see `applyDrag`), and a
 * committed gesture settles optimistically (`pendingOpen`) with navigation
 * deferred until the settle is on the compositor (`deferCommit`), so release doesn't hitch.
 */
export function SwipeReveal({ underlay, children, open, onReveal, onClose }: SwipeRevealProps) {
  const isTouch = useIsTouch();
  // Narrow AND touch, so a small desktop window keeps side-by-side panes.
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

  // Optimistic resting state; `null` whenever the `open` prop is authoritative.
  const [pendingOpen, setPendingOpen] = useState<boolean | null>(null);
  const effectiveOpen = pendingOpen ?? open;

  const paneRef = useRef<HTMLDivElement>(null);
  const underlayRef = useRef<HTMLDivElement>(null);

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

  const onRevealRef = useRef(onReveal);
  onRevealRef.current = onReveal;
  const onCloseRef = useRef(onClose);
  onCloseRef.current = onClose;

  // Frame 1 paints the resting transform (compositor owns the transition),
  // frame 2 runs navigation. Android can stop servicing rAF across
  // background/resume, stranding `pendingOpen`, so a setTimeout backstop races it.
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

  // Only gesture-driven `open` changes animate; navigation changes snap, or the
  // chat visibly slides across the screen.
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

  // Android back reveals the list when the chat is showing (the OS eats in-WebView
  // edge swipes). The revealed list is a root screen, so back from it leaves the
  // app rather than replaying every chat visited before.
  useAndroidBack(() => {
    if (!effectiveOpen) {
      commitReveal();
    } else {
      leaveApp();
    }
    return true;
  }, swipeEnabled);

  // Compositor-run keyframe slide-in on fresh mount, so heavy chat mounting doesn't
  // stutter it. Skipped for deep-link arrivals.
  const [enterAnim, setEnterAnim] = useState(() => swipeEnabled && !open && !isRecentDeepLinkNavigation());

  // Must be removed (see ENTER_ANIM_MAX_MS): a wedged keyframe pins the pane.
  useEffect(() => {
    if (!enterAnim) return;
    const id = window.setTimeout(() => setEnterAnim(false), ENTER_ANIM_MAX_MS);
    return () => window.clearTimeout(id);
  }, [enterAnim]);

  const openSwipe = useEdgeSwipe({
    enabled: swipeEnabled && !effectiveOpen,
    direction: "open",
    onCommit: commitReveal,
    onDragMove: applyDrag,
  });
  const closeSwipe = useEdgeSwipe({
    enabled: swipeEnabled && effectiveOpen,
    direction: "close",
    onCommit: commitClose,
    onDragMove: useCallback(
      (dragX: number) => applyDrag((window.innerWidth || 1) - dragX),
      [applyDrag],
    ),
  });

  // Suppress the transition for one render on non-gesture `open` flips; layout effect so the snap lands pre-paint.
  const prevOpen = useRef(open);
  const [snap, setSnap] = useState(false);
  const cancelOpenSwipe = openSwipe.cancel;
  const cancelCloseSwipe = closeSwipe.cancel;
  useLayoutEffect(() => {
    if (prevOpen.current !== open) {
      setSnap(!gestureCommit.current);
      prevOpen.current = open;
      // Navigation is authoritative: abandon any in-flight drag.
      cancelOpenSwipe();
      cancelCloseSwipe();
      setPendingOpen(null);
    }
    gestureCommit.current = false;
  }, [open, cancelOpenSwipe, cancelCloseSwipe]);
  useEffect(() => {
    if (!snap) return;
    const id = requestAnimationFrame(() => setSnap(false));
    return () => cancelAnimationFrame(id);
  }, [snap]);

  // Spring `pendingOpen` back if navigation never lands, or the pane stays pointer-events-none.
  useEffect(() => {
    if (pendingOpen === null || pendingOpen === open) return;
    const id = window.setTimeout(() => setPendingOpen(null), PENDING_OPEN_MAX_MS);
    return () => window.clearTimeout(id);
  }, [pendingOpen, open]);

  // On resume (Capacitor `appStateChange`; visibility events don't fire, per
  // App.tsx), drop all drag transients and force a commit so transforms are
  // rewritten from the prop.
  const [, bumpResync] = useState(0);
  useEffect(() => {
    if (!swipeEnabled) return;
    return onAppStateChange((active) => {
      if (!active) return;
      cancelOpenSwipe();
      cancelCloseSwipe();
      setPendingOpen(null);
      setEnterAnim(false);
      // Bump unconditionally so the reconciling commit happens.
      bumpResync((n) => n + 1);
    });
  }, [swipeEnabled, cancelOpenSwipe, cancelCloseSwipe]);

  // Gates `will-change`: a permanent hint pins a full-screen compositor layer.
  const [moving, setMoving] = useState(() => enterAnim);
  const firstMotion = useRef(true);
  useEffect(() => {
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
  // Only a drag away from the current rest position counts, so a drag left over
  // from before an `open` flip is inert rather than pinning the pane mid-slide.
  const openDragging = openSwipe.dragging && !effectiveOpen;
  const closeDragging = closeSwipe.dragging && effectiveOpen;
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
  const underlayShift = -(1 - progress) * UNDERLAY_SHIFT_PCT;

  // The drag writes transforms imperatively, so React's style prop may be stale;
  // rewrite the rest position before paint on every commit.
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
    return (
      <>
        {underlay}
        {children}
      </>
    );
  }

  return (
    <>
      {/* Close handlers stay mounted regardless of `open` (the hook self-gates);
          detaching mid-gesture removed the pointerup that ends the drag. */}
      <div
        ref={underlayRef}
        {...closeSwipe.handlers}
        className={cn(
          "absolute inset-0 flex [contain:layout_paint]",
          dragging || snap ? "" : "transition-transform duration-200 ease-out",
          // Reserve the mobile call bar height; `absolute inset-0` ignores the shell's padding.
          "max-sidebar:pb-[var(--call-bar-h,0px)]",
        )}
        style={{
          transform: `translateX(${underlayShift}%)`,
          touchAction: effectiveOpen ? "pan-y" : undefined,
          willChange: moving ? "transform" : undefined,
        }}
        aria-hidden={progress === 0}
      >
        {underlay}
      </div>

      <div
        ref={paneRef}
        {...openSwipe.handlers}
        // Scoped to the pane's own animation; children's bubble here too.
        onAnimationEnd={(e) => {
          if (enterAnim && e.target === e.currentTarget) setEnterAnim(false);
        }}
        className={cn(
          "absolute inset-0 z-10 flex flex-col bg-background shadow-2xl [contain:layout_paint]",
          dragging || snap ? "" : "transition-transform duration-200 ease-out",
          enterAnim && "animate-in slide-in-from-right duration-200 ease-out",
          // Reserve the mobile call bar height; `absolute inset-0` ignores the shell's padding.
          "max-sidebar:pb-[var(--call-bar-h,0px)]",
          // Keyed on the optimistic state so the list is tappable on the release frame.
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
