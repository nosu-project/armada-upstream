import type { RefObject } from "react";

/**
 * Keyboard routing for auto-focusing composers: stray printable keys land in
 * the newest registered composer, and a conversation switch puts the caret
 * back in it — each only while nothing else has a better claim to the keyboard.
 */

const OVERLAY_SELECTOR = "[role='dialog'], [role='alertdialog'], [role='menu'], [role='listbox']";

/**
 * Whether something other than `own` holds the keyboard: a text field, an open
 * dialog/menu `own` isn't inside, or `own` isn't somewhere the user can see and
 * reach — hidden, under an `inert` page (an overlay drawn over it), or outside
 * the element that has the screen to itself in fullscreen.
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

/**
 * Whether the focused element was reached by the keyboard — Tab or arrow keys
 * through the channel list, say. A switch made that way leaves focus where the
 * user is navigating; one made by a click (a mouse-focused link or button, or
 * Safari's focus-on-click-nothing) still hands the caret to the composer.
 */
function keyboardNavigating(own: HTMLElement | null): boolean {
  const active = document.activeElement as HTMLElement | null;
  if (!active || active === document.body || active === document.documentElement) return false;
  if (own && (active === own || own.contains(active))) return false;
  try {
    return active.matches(":focus-visible");
  } catch {
    // No `:focus-visible` support: assume a focused navigation control is
    // being driven from the keyboard.
    return !!active.closest("nav, [role='navigation'], [role='tree'], [role='treeitem'], a, button");
  }
}

/** Whether a conversation switch may move the caret into `own`. */
export function mayFocusOnSwitch(own: HTMLElement | null): boolean {
  return !!own && !keyboardOwnedElsewhere(own) && !keyboardNavigating(own);
}

/**
 * Composers that take stray keystrokes, newest last. One document listener
 * serves them all and hands the key to the newest, so an auto-focusing thread
 * panel wins over the channel composer behind it.
 */
const typeToFocusTargets: RefObject<HTMLTextAreaElement | null>[] = [];

function onStrayKeyDown(e: KeyboardEvent) {
  if (e.defaultPrevented || e.isComposing || e.metaKey) return;
  // AltGr reports as Ctrl+Alt on Windows, and types characters (`@`, `€`, `{`)
  // on most non-US layouts; a real Ctrl/Alt chord is a shortcut.
  if ((e.ctrlKey || e.altKey) && !e.getModifierState?.("AltGraph")) return;
  // A single character is a printable key; "Enter", "Tab", "ArrowUp" etc. aren't.
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
