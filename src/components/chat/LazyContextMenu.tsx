import { useCallback, useRef, useState, type ReactNode } from "react";
import { createPortal } from "react-dom";

import { DropdownMenu, DropdownMenuContent, DropdownMenuTrigger } from "@/components/ui/dropdown-menu";
import { cn } from "@/lib/utils";

export interface LazyContextMenu {
  open: boolean;
  /** Where the last right-click landed; `null` until the first one. */
  point: { x: number; y: number } | null;
  setOpen: (open: boolean) => void;
  onContextMenu: (event: React.MouseEvent) => void;
}

/**
 * Right-click menu whose Radix root is built on first right-click, as a SIBLING
 * of the row anchored at the pointer. A per-row ContextMenu mounted a Popper per
 * row plus a second render pass.
 */
export function useLazyContextMenu(onOpenChange?: (open: boolean) => void): LazyContextMenu {
  const [point, setPoint] = useState<{ x: number; y: number } | null>(null);
  const [open, setOpenState] = useState(false);
  const onOpenChangeRef = useRef(onOpenChange);
  onOpenChangeRef.current = onOpenChange;

  const setOpen = useCallback((next: boolean) => {
    setOpenState(next);
    onOpenChangeRef.current?.(next);
  }, []);

  const onContextMenu = useCallback(
    (event: React.MouseEvent) => {
      event.preventDefault();
      setPoint({ x: event.clientX, y: event.clientY });
      setOpen(true);
    },
    [setOpen],
  );

  return { open, point, setOpen, onContextMenu };
}

/** Anchored at the click point, placed like Radix's context menu. Latched once built so closing animates. */
export function LazyContextMenuContent({
  menu,
  className,
  collisionPadding,
  onCloseAutoFocus,
  children,
}: {
  menu: LazyContextMenu;
  className?: string;
  collisionPadding?: number | Partial<Record<"top" | "right" | "bottom" | "left", number>>;
  onCloseAutoFocus?: (event: Event) => void;
  children: ReactNode;
}) {
  const { point, open, setOpen } = menu;
  if (!point) return null;
  return createPortal(
    <DropdownMenu open={open} onOpenChange={setOpen}>
      <DropdownMenuTrigger asChild>
        <span
          aria-hidden
          tabIndex={-1}
          style={{ position: "fixed", left: point.x, top: point.y, width: 0, height: 0, pointerEvents: "none" }}
        />
      </DropdownMenuTrigger>
      <DropdownMenuContent
        side="right"
        align="start"
        sideOffset={2}
        collisionPadding={collisionPadding}
        // Inert while closing: Radix items focus on pointermove and would steal focus
        // from where the action put it.
        className={cn("data-[state=closed]:pointer-events-none", className)}
        // Never return focus to the invisible anchor.
        onCloseAutoFocus={(event) => {
          onCloseAutoFocus?.(event);
          event.preventDefault();
        }}
      >
        {children}
      </DropdownMenuContent>
    </DropdownMenu>,
    document.body,
  );
}
