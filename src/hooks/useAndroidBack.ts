import { App } from "@capacitor/app";
import { Capacitor } from "@capacitor/core";
import { useEffect, useRef } from "react";
import { flushSync } from "react-dom";

/**
 * Android hardware/gesture "back" handling.
 *
 * On Android, system gesture navigation reserves both screen edges, so an
 * in-WebView left-edge swipe is intercepted by the OS before our pointer
 * handlers see it (it triggers WebView history back/forward). The robust,
 * platform-native way to drive "go back one level" — e.g. slide the chat away
 * to reveal the channel list — is to listen for the system back event itself
 * (`@capacitor/app`'s `backButton`, which fires for both the gesture and the
 * 3-button back) and run our own handler instead of letting the WebView walk
 * its history.
 *
 * Handlers are a LIFO stack: the most recently mounted view (the screen the
 * user is actually looking at) gets first crack at the back event. A handler
 * returns `true` if it consumed the event (back stops there) or `false` to let
 * the next handler / default behavior run. When no handler consumes it we fall
 * back to history navigation, and at the history root we minimize the app
 * (Android's expected behavior) rather than killing it.
 */

type BackHandler = () => boolean;

const stack: BackHandler[] = [];
let listenerInstalled = false;

function handleBack() {
  // Walk the stack top-down; the first handler that consumes the event wins.
  for (let i = stack.length - 1; i >= 0; i--) {
    try {
      if (stack[i]()) return;
    } catch {
      // A throwing handler shouldn't trap the user — fall through to the next.
    }
  }
  // Nobody consumed it: behave like a normal back press. If there's app
  // history, walk it; otherwise we're at the root, so minimize the app (the
  // expected Android gesture, vs. exitApp which fully kills the process).
  if (window.history.length > 1) {
    window.history.back();
  } else {
    void App.minimizeApp().catch(() => undefined);
  }
}

export function ensureAndroidBackListener() {
  ensureListener();
}

function ensureListener() {
  if (listenerInstalled || !Capacitor.isNativePlatform()) return;
  listenerInstalled = true;
  // capacitor's backButton fires for the gesture-nav back swipe and the
  // 3-button back. We always handle it ourselves (never let the WebView
  // auto-navigate), which is why MainActivity doesn't override onBackPressed.
  void App.addListener("backButton", () => handleBack());
}

/**
 * Register a handler for the Android system back gesture/button while the
 * calling component is mounted and `active` is true. The handler should return
 * `true` if it handled the back (e.g. it closed a panel or revealed the list)
 * or `false` to defer to handlers registered lower in the stack / the default.
 *
 * No-op outside the native runtime (web/PWA keep the browser's own back). An
 * overlay that should also close on a browser back uses `useOverlayBack`.
 */
export function useAndroidBack(handler: BackHandler, active = true): void {
  // Keep the latest handler closure in a ref so we register a single stable
  // entry on the stack (and don't churn it every render).
  const ref = useRef(handler);
  ref.current = handler;

  useEffect(() => {
    if (!active || !Capacitor.isNativePlatform()) return;
    ensureListener();
    const entry: BackHandler = () => ref.current();
    stack.push(entry);
    return () => {
      const i = stack.indexOf(entry);
      if (i >= 0) stack.splice(i, 1);
    };
  }, [active]);
}

/*
 * Browser back for overlays.
 *
 * Outside the native runtime there is no back EVENT to consume — the browser
 * (and a PWA's Android back, which is the same thing) walks history, so a
 * sheet open over a chat is left on screen while the route under it leaves.
 * The only way to make back close the sheet instead is to give it an entry of
 * its own: while any overlay is open, ONE guard entry (the current URL, its
 * router state copied, plus a token) sits on top of history. Back pops it, and
 * the popstate runs the topmost overlay's handler — which may unwind a layer
 * rather than close, in which case the guard is pushed again.
 *
 * An overlay that closes some other way (tap outside, swipe, an action) pops
 * its own guard, so the next back isn't a dead press. That pop is deferred a
 * task so an action that closes the sheet AND navigates lands first: the guard
 * is then under the new route rather than on top, and popping would undo the
 * navigation. Such a buried guard is remembered and skipped once when back
 * reaches it, since it only duplicates the entry beneath.
 */

const GUARD_KEY = "armadaBackGuard";

const webStack: BackHandler[] = [];
/** The token of the guard entry we believe is on top of history, if any. */
let guard: string | null = null;
/** Guards a navigation pushed over before they could be popped. */
const buried = new Set<string>();
/** Our own `history.back()` is in flight; don't push over it. */
let pendingPop = false;
let pendingPopTimer: ReturnType<typeof setTimeout> | undefined;
let settleTimer: ReturnType<typeof setTimeout> | undefined;
let webListenerInstalled = false;
let guardSerial = 0;

function guardOf(state: unknown): string | undefined {
  const token = (state as Record<string, unknown> | null)?.[GUARD_KEY];
  return typeof token === "string" ? token : undefined;
}

function endPendingPop() {
  pendingPop = false;
  clearTimeout(pendingPopTimer);
  pendingPopTimer = undefined;
}

/** Bring history in line with the overlay stack: a guard on top iff one is open. */
function settle() {
  settleTimer = undefined;
  if (pendingPop) return;
  if (guard !== null && guardOf(window.history.state) !== guard) {
    buried.add(guard);
    guard = null;
  }
  if (webStack.length > 0) {
    if (guard !== null) return;
    guard = `${Date.now().toString(36)}-${++guardSerial}`;
    const state = (window.history.state as Record<string, unknown> | null) ?? {};
    window.history.pushState({ ...state, [GUARD_KEY]: guard }, "");
  } else if (guard !== null) {
    guard = null;
    pendingPop = true;
    // A traversal that never reports back mustn't switch this off for good.
    pendingPopTimer = setTimeout(endPendingPop, 1000);
    window.history.back();
  }
}

function scheduleSettle() {
  if (settleTimer === undefined) settleTimer = setTimeout(settle, 0);
}

function onPopState(e: PopStateEvent) {
  const landed = guardOf(e.state);
  if (pendingPop) {
    endPendingPop();
    scheduleSettle();
    return;
  }
  if (guard !== null && landed !== guard) {
    // The user stepped back off the guard: that back belongs to the overlay.
    guard = null;
    flushSync(() => {
      for (let i = webStack.length - 1; i >= 0; i--) {
        try {
          if (webStack[i]()) return;
        } catch {
          // A throwing handler shouldn't trap the user — fall through.
        }
      }
    });
    scheduleSettle();
    return;
  }
  if (landed !== undefined && buried.delete(landed)) window.history.back();
}

function ensureWebListener() {
  if (webListenerInstalled) return;
  webListenerInstalled = true;
  window.addEventListener("popstate", onPopState);
}

/**
 * Back handling for an overlay (a sheet, a lightbox): the system back closes
 * it — or unwinds one layer of it — rather than navigating the screen beneath.
 *
 * Natively this is `useAndroidBack`. In a browser or PWA it holds a history
 * entry while `active` (see above), so it is for surfaces that are dismissed
 * like a modal, not for panes whose back is a real navigation.
 */
export function useOverlayBack(handler: BackHandler, active = true): void {
  useAndroidBack(handler, active);

  const ref = useRef(handler);
  ref.current = handler;

  useEffect(() => {
    if (!active || Capacitor.isNativePlatform()) return;
    ensureWebListener();
    const entry: BackHandler = () => ref.current();
    webStack.push(entry);
    scheduleSettle();
    return () => {
      const i = webStack.indexOf(entry);
      if (i >= 0) webStack.splice(i, 1);
      scheduleSettle();
    };
  }, [active]);
}
