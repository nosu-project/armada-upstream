/** Set while {@link cancelPressUnder} dispatches, so a gesture doesn't abandon itself on its own cancel. */
let cancelling = false;

export function isCancellingPress(): boolean {
  return cancelling;
}

/**
 * Tell the pressed element (and its ancestors) the press is over. A gesture that
 * captures the pointer or prevents its moves starves the target of the move/up a
 * long-press timer (Radix ContextMenu) clears on, so the menu would open mid-gesture.
 */
export function cancelPressUnder(
  target: EventTarget | null,
  boundary: Element | null,
  pointerId: number,
  pointerType: string,
): void {
  if (!(target instanceof Element) || target === boundary) return;
  const init = { bubbles: true, pointerId, pointerType };
  const ev = typeof PointerEvent === "function"
    ? new PointerEvent("pointercancel", init)
    : Object.assign(new Event("pointercancel", init), { pointerId, pointerType });
  cancelling = true;
  try {
    target.dispatchEvent(ev);
  } finally {
    cancelling = false;
  }
}
