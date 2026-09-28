import { cn } from "@/lib/utils";

import type { ReactNode } from "react";

/**
 * Thread panel slot: in-flow and width-animated at ≥1200px (`thread:`),
 * otherwise an absolute overlay. `children` stays mounted through the slide-out
 * via {@link useThreadPanel}'s `lastThreadRoot`.
 */
export function ThreadPanelSlot({
  open,
  expanded,
  children,
}: {
  open: boolean;
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
