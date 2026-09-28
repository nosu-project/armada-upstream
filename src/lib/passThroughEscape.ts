/**
 * Let a Radix layer close on Escape without consuming it. Radix prevents the
 * Escape before dismissing, which swallows it for passive layers (e.g. a hover
 * popover while typing). Call from `onEscapeKeyDown` and close via your own
 * state: Radix sees `defaultPrevented === true`, and a capture listener on the
 * target restores the real state for everything below the document.
 */
export function passThroughEscape(event: KeyboardEvent): void {
  Object.defineProperty(event, "defaultPrevented", { configurable: true, get: () => true });
  const release = () => {
    delete (event as { defaultPrevented?: boolean }).defaultPrevented;
  };
  const target = event.target;
  // A listener added to the currently dispatching node won't run for this event,
  // so when the target IS the document, release on the next task instead.
  if (target && target !== event.currentTarget) {
    target.addEventListener("keydown", release, { capture: true, once: true });
  }
  setTimeout(release, 0);
}
