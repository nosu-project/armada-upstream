import { useCallback, useRef, useState, type ReactNode } from "react";
import { createPortal } from "react-dom";

import { DropdownMenu, DropdownMenuContent, DropdownMenuTrigger } from "@/components/ui/dropdown-menu";
import { cn } from "@/lib/utils";

export interface LazyContextMenu {
  open: boolean;
  /** Where the last right-click landed; `null` until the first one. */
  point: { x: number; y: number } | null;
  setOpen: (open: boolean) => void;
  /** Spread on the element the right-click belongs to. */
  onContextMenu: (event: React.MouseEvent) => void;
}

/**
 * A right-click menu whose Radix root is built on the first right-click rather
 * than with its row.
 *
 * Radix's `ContextMenu` has to wrap its trigger, so a timeline that offers one
 * per message mounts a Menu root, a Popper and an anchor per row, and every
 * anchor sets its Popper's state after mount — a second render pass for every
 * row paged in, and a subtree deep enough that any context change above the
 * timeline walks all of it. Here the row only carries a `contextmenu` handler;
 * the menu itself (see {@link LazyContextMenuContent}) is a SIBLING of the row,
 * anchored at the pointer, so building it on demand never remounts the row it
 * belongs to.
 *
 * A touch or pen long-press on a hover device still arrives as a native
 * `contextmenu` event, which is all this listens for.
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

/**
 * The menu for {@link useLazyContextMenu}: nothing until the first right-click,
 * then a dropdown anchored to a zero-size point where it landed, placed the way
 * Radix places a context menu (to the right of the pointer, top-aligned).
 * Latched once built, so closing still animates.
 */
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
        // Inert while it animates out: a Radix item focuses itself on
        // pointermove, so a mouse still over the closing menu took focus back
        // from wherever the action put it (Reply's composer) and dropped it on
        // the body when the menu unmounted.
        className={cn("data-[state=closed]:pointer-events-none", className)}
        // Never return focus to the invisible anchor: leave it where an action
        // put it, as the context menu this replaces did.
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
