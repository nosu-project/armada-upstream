/**
 * Let a Radix layer close on an Escape without CONSUMING it.
 *
 * Radix's DismissableLayer listens for Escape in the capture phase on the
 * document and, unless `onEscapeKeyDown` prevented the event, prevents it
 * itself before dismissing. Either way the page below sees a prevented Escape.
 * That is right for a layer holding focus, and wrong for a passive one — a
 * hover popover the pointer happens to rest on while the keyboard is in the
 * composer: the Escape meant for the composer (drop the reply target) is
 * swallowed, and a second press is needed.
 *
 * Call this from `onEscapeKeyDown` and close the layer through your own state.
 * Radix is shown `defaultPrevented === true`, so it neither dismisses nor
 * prevents; the shadow is removed by a capture listener on the event's target,
 * which runs before any listener at the target or below it in the bubble, so
 * everything past the document sees the event's REAL state — including a later
 * `preventDefault()` from, say, an open autocomplete.
 */
export function passThroughEscape(event: KeyboardEvent): void {
  Object.defineProperty(event, "defaultPrevented", { configurable: true, get: () => true });
  const release = () => {
    delete (event as { defaultPrevented?: boolean }).defaultPrevented;
  };
  const target = event.target;
  // A listener added to the node currently dispatching would not run for this
  // event, so an Escape whose target IS the document has nothing below it to
  // hand the event to — release on the next task instead.
  if (target && target !== event.currentTarget) {
    target.addEventListener("keydown", release, { capture: true, once: true });
  }
  setTimeout(release, 0);
}
