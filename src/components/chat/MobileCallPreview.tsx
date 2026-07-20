import { Maximize2, X } from "lucide-react";
import { useEffect, useRef } from "react";

import { useIsDesktop } from "@/hooks/useIsDesktop";
import { cn } from "@/lib/utils";

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
 * preview pinned to the bottom-right, sitting directly ABOVE the fixed
 * MobileCallBar (offset by the bar's measured `--call-bar-h` plus the bottom
 * safe-area inset). This keeps the first version simple and predictable, and
 * keeps the composer, bottom navigation, and the call bar itself clear.
 *
 * The preview's own chrome carries only the actions that must live here:
 * "return to call" (expand) and "hide". The mic / camera / screen-share / leave
 * controls stay in the always-present MobileCallBar, so they aren't duplicated;
 * the stage's floating branch renders only the primary content (and, when more
 * than one screen share is live, the share switcher) — see CallStage.
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
  const bodyRef = useRef<HTMLDivElement | null>(null);

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

  return (
    <div
      className={cn(
        "fixed right-2 z-40 flex w-44 flex-col overflow-hidden select-none",
        "clip-corner-lg bg-chrome-deep shadow-2xl ring-1 ring-white/10",
        "animate-in fade-in-0 slide-in-from-bottom-2 duration-200",
        "sidebar:hidden",
      )}
      style={{
        // Sit directly above the fixed MobileCallBar: its measured height
        // (--call-bar-h, written on the shell) already folds in the bottom
        // safe-area inset (the bar uses pb-safe), plus a small gap. Falls back
        // to just the safe-area inset before the bar has measured itself.
        bottom:
          "calc(var(--call-bar-h, var(--safe-area-inset-bottom, env(safe-area-inset-bottom, 0px))) + 0.5rem)",
        // Never wider than the viewport minus the side gutters.
        maxWidth: "calc(100vw - 1rem)",
      }}
    >
      <div className="flex items-center gap-1 px-1 py-1 shrink-0 border-b border-white/10">
        <span className="flex-1 min-w-0 truncate px-1 text-xs font-medium text-muted-foreground">
          Call
        </span>
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
