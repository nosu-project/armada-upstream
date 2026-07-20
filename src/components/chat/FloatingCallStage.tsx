import { Maximize2, X } from "lucide-react";
import { useEffect, useRef } from "react";

import { useIsDesktop } from "@/hooks/useIsDesktop";
import { cn } from "@/lib/utils";

/**
 * The compact floating video window ("in-app PiP") shown while a call is active
 * but its channel is off screen. It is pure chrome: a fixed desktop panel whose
 * body is registered as the floating stage host, into which CallProvider
 * reparents the persistent stage host (where the one-and-only `CallStage`
 * lives). Because it's the SAME stage element being moved — not a second stage
 * — there is never a duplicate LiveKit subscription, and video keeps playing
 * across the reparent (CallProvider re-kicks any paused `<video>` on move).
 *
 * Desktop only: below the `sidebar` breakpoint we render nothing and register
 * no host, so the stage parks off-DOM and the existing fixed mobile call bar
 * stays the sole voice UI (a floating video overlay on a phone would fight the
 * bar and the composer). Native browser Picture-in-Picture is intentionally
 * out of scope for this window.
 */
export function FloatingCallStage({
  registerSlot,
  onExpand,
  onHide,
}: {
  /** Register (or clear, with null) the body element as the floating stage host. */
  registerSlot: (el: HTMLElement | null) => void;
  /** Return to the full call view (navigate to the call's channel). */
  onExpand?: () => void;
  /** Hide the floating window without leaving the call. */
  onHide: () => void;
}) {
  const isDesktop = useIsDesktop();
  const bodyRef = useRef<HTMLDivElement | null>(null);

  // Register the body as the reparent target only on desktop and only while
  // mounted; clearing on unmount/mobile parks the stage off-DOM instead of
  // stranding it inside a hidden panel (a display:none ancestor pauses video).
  useEffect(() => {
    if (!isDesktop) {
      registerSlot(null);
      return;
    }
    const el = bodyRef.current;
    if (!el) return;
    registerSlot(el);
    return () => registerSlot(null);
  }, [isDesktop, registerSlot]);

  // Mobile: no floating window (the fixed call bar remains the voice UI).
  if (!isDesktop) return null;

  return (
    <div
      className={cn(
        // Bottom-right so it clears the bottom-left desktop call-bar fallback.
        "fixed bottom-3 right-3 z-40 flex flex-col overflow-hidden",
        "w-80 max-w-[calc(100vw-1.5rem)] clip-corner-lg bg-chrome-deep shadow-2xl ring-1 ring-white/10",
        "animate-in fade-in-0 slide-in-from-bottom-2 duration-200",
      )}
    >
      <div className="flex items-center gap-1 px-2 py-1 shrink-0 border-b border-white/10">
        <span className="text-xs font-medium text-muted-foreground truncate flex-1 min-w-0">
          Call
        </span>
        {onExpand && (
          <button
            type="button"
            aria-label="Return to call"
            title="Return to call"
            onClick={onExpand}
            className="shrink-0 rounded-md p-1 text-muted-foreground hover:text-foreground hover:bg-foreground/10"
          >
            <Maximize2 className="size-4" />
          </button>
        )}
        <button
          type="button"
          aria-label="Hide floating video"
          title="Hide floating video"
          onClick={onHide}
          className="shrink-0 rounded-md p-1 text-muted-foreground hover:text-foreground hover:bg-foreground/10"
        >
          <X className="size-4" />
        </button>
      </div>
      {/* The reparent target: CallProvider appends the stage host here. Fixed
          16:9-ish height gives CallStage's fit math a definite box to size to. */}
      <div ref={bodyRef} className="h-44 w-full" />
    </div>
  );
}
