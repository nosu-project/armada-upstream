import type { RefObject } from "react";

/**
 * Keyboard routing for auto-focusing composers: stray printable keys and
 * conversation switches put the caret in the newest composer, unless something
 * else has a better claim to the keyboard.
 */

const OVERLAY_SELECTOR = "[role='dialog'], [role='alertdialog'], [role='menu'], [role='listbox']";

/**
 * Something other than `own` holds the keyboard: a text field, an open
 * dialog/menu outside `own`, or `own` is hidden, `inert`, or outside the
 * fullscreen element.
 */
export function keyboardOwnedElsewhere(own: HTMLElement | null): boolean {
  const active = document.activeElement as HTMLElement | null;
  if (active && active !== own && (active.isContentEditable || /^(input|textarea|select)$/i.test(active.tagName))) return true;
  const overlays = document.querySelectorAll(OVERLAY_SELECTOR);
  if (Array.from(overlays).some((overlay) => !own || !overlay.contains(own))) return true;
  if (!own) return false;
  if (own.closest("[inert]")) return true;
  if (own.checkVisibility?.() === false) return true;
  const fullscreen = document.fullscreenElement;
  if (fullscreen && !fullscreen.contains(own)) return true;
  return false;
}

/** Focus reached by keyboard (Tab/arrows through the channel list) stays put on a switch. */
function keyboardNavigating(own: HTMLElement | null): boolean {
  const active = document.activeElement as HTMLElement | null;
  if (!active || active === document.body || active === document.documentElement) return false;
  if (own && (active === own || own.contains(active))) return false;
  try {
    return active.matches(":focus-visible");
  } catch {
    // No `:focus-visible` support: assume a focused navigation control is keyboard-driven.
    return !!active.closest("nav, [role='navigation'], [role='tree'], [role='treeitem'], a, button");
  }
}

export function mayFocusOnSwitch(own: HTMLElement | null): boolean {
  return !!own && !keyboardOwnedElsewhere(own) && !keyboardNavigating(own);
}

/** Newest last; one document listener hands keys to the newest (a thread panel beats the channel composer). */
const typeToFocusTargets: RefObject<HTMLTextAreaElement | null>[] = [];

function onStrayKeyDown(e: KeyboardEvent) {
  if (e.defaultPrevented || e.isComposing || e.metaKey) return;
  // AltGr reports as Ctrl+Alt on Windows and types characters on non-US layouts.
  if ((e.ctrlKey || e.altKey) && !e.getModifierState?.("AltGraph")) return;
  if (e.key.length !== 1) return;
  const active = document.activeElement as HTMLElement | null;
  // Space activates a focused button or link; leave that alone.
  if (e.key === " " && active && active !== document.body) return;
  const target = typeToFocusTargets.at(-1)?.current;
  if (!target || target === active || target.disabled || target.readOnly || !target.isConnected) return;
  if (keyboardOwnedElsewhere(target)) return;
  // Focusing during keydown routes this same keystroke's input to the textarea.
  target.focus({ preventScroll: true });
}

export function registerTypeToFocus(ref: RefObject<HTMLTextAreaElement | null>): () => void {
  if (typeToFocusTargets.length === 0) document.addEventListener("keydown", onStrayKeyDown);
  typeToFocusTargets.push(ref);
  return () => {
    const i = typeToFocusTargets.lastIndexOf(ref);
    if (i !== -1) typeToFocusTargets.splice(i, 1);
    if (typeToFocusTargets.length === 0) document.removeEventListener("keydown", onStrayKeyDown);
  };
}
