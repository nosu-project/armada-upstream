import { cn } from "@/lib/utils";

import type { ReactNode } from "react";

/**
 * The thread panel's slot, which is two different layouts at two widths.
 *
 * Wide (≥1200px, the `thread:` variant): an in-flow sibling of the chat whose
 * width animates open, pushing the timeline aside. Narrower — including the
 * 900–1200 band where the rail and channel list are shown but there is no room
 * for a 23rem push — it overlays the chat absolutely and slides in over a
 * fading backdrop.
 *
 * `children` is the caller's `ThreadPanel`, kept mounted through the slide-out
 * by {@link useThreadPanel}'s `lastThreadRoot`.
 */
export function ThreadPanelSlot({
  open,
  expanded,
  children,
}: {
  /** Whether a thread is routed open. */
  open: boolean;
  /** Whether it's expanded to full width. */
  expanded: boolean;
  children: ReactNode;
}) {
  return (
    <div
      className={cn(
        "overflow-hidden",
        "absolute inset-0 z-20 thread:static thread:z-auto",
        "thread:transition-[width] thread:duration-200 thread:ease-out",
        open
          ? expanded
            ? "thread:flex-1 thread:w-full"
            : "thread:shrink-0 thread:w-[23rem]"
          : "thread:shrink-0 thread:w-0 pointer-events-none thread:pointer-events-auto",
      )}
    >
      {/* Mobile backdrop: fades in/out in sync with the panel slide. */}
      <div
        className={cn(
          "absolute inset-0 bg-background transition-opacity duration-200 ease-out thread:hidden",
          open ? "opacity-100" : "opacity-0",
        )}
      />
      <div
        className={cn(
          "relative h-full flex w-full transition-transform duration-200 ease-out",
          open ? "translate-x-0" : "translate-x-full",
          expanded ? "thread:w-full" : "thread:w-[23rem]",
        )}
      >
        {children}
      </div>
    </div>
  );
}
