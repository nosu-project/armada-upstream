import { ArrowLeftRight, Maximize2, Ruler, X } from "lucide-react";
import { useCallback, useEffect, useRef } from "react";

import { useCall } from "@/hooks/useCall";
import { useIsDesktop } from "@/hooks/useIsDesktop";
import { useLocalStorage } from "@/hooks/useLocalStorage";
import { cn } from "@/lib/utils";

/** Which corner the preview snaps to. */
type Side = "left" | "right";
/** The preview size preset. */
type SizePreset = "small" | "medium" | "large";

/** localStorage keys for the persisted preview size + side. */
const SIZE_KEY = "armada:mobile-call-preview:size";
const SIDE_KEY = "armada:mobile-call-preview:side";

/** The gap kept from each viewport side edge and from the call bar (0.5rem). */
const EDGE_GAP = "0.5rem";

/**
 * The three responsive width presets. Each is viewport-relative so it tracks
 * rotation/resize natively (pure CSS, no JS resize listener), with a fixed
 * lower bound so it stays useful on narrow phones and an upper bound so it
 * never grows absurdly on wide/landscape viewports. All are additionally capped
 * to `calc(100vw - 1rem)` on the element (`maxWidth`), so even the lower bound
 * can't touch the side gutters on an unusually narrow device.
 *
 *   small  = clamp(128px, 42vw, 190px)  — minimal but legible preview
 *   medium = clamp(168px, 62vw, 288px)  — comfortable general call preview (default)
 *   large  = min(100vw - 1rem, 460px)   — most of the viewport width, edges clear
 *
 * The body below the header is `aspect-video` (16:9), so height follows width
 * and the video aspect ratio is always preserved.
 */
const SIZE_WIDTH: Record<SizePreset, string> = {
  small: "clamp(128px, 42vw, 190px)",
  medium: "clamp(168px, 62vw, 288px)",
  large: "min(calc(100vw - 1rem), 460px)",
};

/** Human labels for the size toggle (announced + shown, never icon/color only). */
const SIZE_LABEL: Record<SizePreset, string> = {
  small: "Small",
  medium: "Medium",
  large: "Large",
};

/** Cycle order for the size toggle. */
const SIZE_ORDER: SizePreset[] = ["small", "medium", "large"];

function nextSize(cur: SizePreset): SizePreset {
  return SIZE_ORDER[(SIZE_ORDER.indexOf(cur) + 1) % SIZE_ORDER.length];
}

function isSize(v: string): v is SizePreset {
  return v === "small" || v === "medium" || v === "large";
}
function isSide(v: string): v is Side {
  return v === "left" || v === "right";
}

/**
 * The compact mobile video preview shown while a call is active but its channel
 * is off screen. It is the mobile counterpart to the draggable desktop
 * `FloatingCallStage`: pure chrome whose body is registered as the floating
 * stage host, into which CallProvider reparents the persistent stage host
 * (where the one-and-only `CallStage` lives). Because it's the SAME stage
 * element being moved — not a second stage — there is never a duplicate LiveKit
 * subscription, and video keeps playing across the reparent (CallProvider
 * re-kicks any paused `<video>` on move).
 *
 * Unlike the desktop window it is NOT draggable. It is a fixed, corner-snapped
 * preview pinned to the bottom-LEFT or bottom-RIGHT (user's choice, persisted),
 * sitting directly ABOVE the fixed MobileCallBar. Its bottom offset is driven
 * by the bar's measured height reported through the call context
 * (`callBarHeight`) — a guaranteed shared value that doesn't depend on
 * CSS-variable inheritance — so it re-evaluates reactively whenever the bar
 * resizes (keyboard open/close, participant count, safe-area/orientation). The
 * bar's height already folds in the bottom safe-area inset (it uses pb-safe),
 * so a single gap above it clears the composer, bottom navigation, and the bar.
 *
 * The user picks one of three responsive size presets (small/medium/large,
 * default medium; see SIZE_WIDTH) and the side; both persist to localStorage.
 * Width is viewport-relative and clamped, so sizing stays correct across
 * rotation/resize and on narrow devices, and the 16:9 body preserves the video
 * aspect ratio.
 *
 * The preview's own chrome carries only the actions that must live here:
 * "return to call" (expand), "hide", "change size", and "change side". The mic
 * / camera / screen-share / leave controls stay in the always-present
 * MobileCallBar, so they aren't duplicated; the stage's floating branch renders
 * only the primary content (and, when more than one screen share is live, the
 * share switcher) — see CallStage.
 *
 * Mobile only: at/above the `sidebar` breakpoint we render nothing and register
 * no host, so the desktop `FloatingCallStage` (which registers only at that
 * breakpoint) is the sole floating destination there. The two never register at
 * once. Native browser Picture-in-Picture is out of scope.
 */
export function MobileCallPreview({
  registerSlot,
  onExpand,
  onHide,
}: {
  /** Register (or clear, with null) the body element as the floating stage host. */
  registerSlot: (el: HTMLElement | null, variant?: "desktop" | "mobile") => void;
  /** Return to the full call view (navigate to the call's channel). */
  onExpand?: () => void;
  /** Hide the preview without leaving the call. */
  onHide: () => void;
}) {
  const isDesktop = useIsDesktop();
  const { callBarHeight } = useCall();
  const bodyRef = useRef<HTMLDivElement | null>(null);

  const [size, setSize] = useLocalStorage<SizePreset>(SIZE_KEY, "medium", {
    serialize: (v) => v,
    deserialize: (v) => (isSize(v) ? v : "medium"),
  });
  const [side, setSide] = useLocalStorage<Side>(SIDE_KEY, "right", {
    serialize: (v) => v,
    deserialize: (v) => (isSide(v) ? v : "right"),
  });

  const cycleSize = useCallback(() => setSize((s) => nextSize(s)), [setSize]);
  const flipSide = useCallback(() => setSide((s) => (s === "right" ? "left" : "right")), [setSide]);

  // Register the body as the reparent target only on mobile and only while
  // mounted; clearing on unmount/desktop parks the stage off-DOM instead of
  // stranding it inside a hidden panel (a display:none ancestor pauses video).
  // Registers under the "mobile" variant so the stage's floating branch knows
  // to omit the media control row (MobileCallBar already carries it).
  useEffect(() => {
    if (isDesktop) {
      registerSlot(null, "mobile");
      return;
    }
    const el = bodyRef.current;
    if (!el) return;
    registerSlot(el, "mobile");
    return () => registerSlot(null, "mobile");
  }, [isDesktop, registerSlot]);

  // Desktop: no mobile preview (the draggable FloatingCallStage is the floating
  // destination there).
  if (isDesktop) return null;

  const width = SIZE_WIDTH[size];
  // Sit directly above the fixed MobileCallBar. `callBarHeight` already folds in
  // the bottom safe-area inset (the bar uses pb-safe); add one gap. Before the
  // bar has measured itself (callBarHeight === 0) fall back to just the
  // safe-area inset so the first frame still clears the home indicator.
  const bottom =
    callBarHeight > 0
      ? `calc(${callBarHeight}px + ${EDGE_GAP})`
      : `calc(var(--safe-area-inset-bottom, env(safe-area-inset-bottom, 0px)) + ${EDGE_GAP})`;

  return (
    <div
      className={cn(
        "fixed z-40 flex flex-col overflow-hidden select-none",
        "clip-corner-lg bg-chrome-deep shadow-2xl ring-1 ring-white/10",
        "animate-in fade-in-0 slide-in-from-bottom-2 duration-200",
        "sidebar:hidden",
      )}
      style={{
        bottom,
        // Corner-snapped to the chosen side, one gap in from the edge.
        left: side === "left" ? EDGE_GAP : undefined,
        right: side === "right" ? EDGE_GAP : undefined,
        width,
        // Final clamp: never touch the side gutters even at the preset's lower
        // bound on an unusually narrow device.
        maxWidth: "calc(100vw - 1rem)",
      }}
    >
      <div className="flex items-center gap-0.5 px-1 py-0.5 shrink-0 border-b border-white/10">
        <span className="flex-1 min-w-0 truncate px-1 text-xs font-medium text-muted-foreground">
          Call
        </span>
        <button
          type="button"
          aria-label={`Preview size: ${SIZE_LABEL[size]}. Tap to change size`}
          title={`Size: ${SIZE_LABEL[size]} (tap to change)`}
          onClick={cycleSize}
          className="shrink-0 inline-flex items-center gap-0.5 rounded-md px-1 py-1 text-muted-foreground hover:text-foreground hover:bg-foreground/10 touch:px-1.5 touch:py-1.5"
        >
          <Ruler className="size-4" />
          {/* Text label so the current size isn't communicated by icon alone. */}
          <span className="text-[10px] font-semibold uppercase tabular-nums">
            {SIZE_LABEL[size][0]}
          </span>
        </button>
        <button
          type="button"
          aria-label={`Move preview to the ${side === "right" ? "left" : "right"}`}
          title={`Move to ${side === "right" ? "left" : "right"}`}
          onClick={flipSide}
          className="shrink-0 rounded-md p-1 text-muted-foreground hover:text-foreground hover:bg-foreground/10 touch:p-1.5"
        >
          <ArrowLeftRight className="size-4" />
        </button>
        {onExpand && (
          <button
            type="button"
            aria-label="Return to call"
            title="Return to call"
            onClick={onExpand}
            className="shrink-0 rounded-md p-1 text-muted-foreground hover:text-foreground hover:bg-foreground/10 touch:p-1.5"
          >
            <Maximize2 className="size-4" />
          </button>
        )}
        <button
          type="button"
          aria-label="Hide video preview"
          title="Hide video preview"
          onClick={onHide}
          className="shrink-0 rounded-md p-1 text-muted-foreground hover:text-foreground hover:bg-foreground/10 touch:p-1.5"
        >
          <X className="size-4" />
        </button>
      </div>
      {/* The reparent target: CallProvider appends the stage host here. The
          host's CallStage floating branch renders the compact preview (and, for
          multiple screen shares, the share switcher) — but NOT the media
          controls, which stay in MobileCallBar. */}
      <div ref={bodyRef} className="w-full" />
    </div>
  );
}
