import { App } from "@capacitor/app";
import { Capacitor } from "@capacitor/core";
import { useEffect, useRef } from "react";
import { flushSync } from "react-dom";

/**
 * Android hardware/gesture "back" handling via `@capacitor/app`'s `backButton`
 * (gesture nav steals edge swipes from the WebView). Handlers form a LIFO stack;
 * returning `true` consumes the event. Unconsumed → history back, or minimize at
 * the root.
 */

type BackHandler = () => boolean;

const stack: BackHandler[] = [];
let listenerInstalled = false;

function handleBack() {
  for (let i = stack.length - 1; i >= 0; i--) {
    try {
      if (stack[i]()) return;
    } catch {
      // A throwing handler shouldn't trap the user — fall through to the next.
    }
  }
  // Unconsumed: walk history, or minimize at the root (not exitApp, which kills it).
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
  // We always handle backButton ourselves, which is why MainActivity doesn't override onBackPressed.
  void App.addListener("backButton", () => handleBack());
}

/**
 * Register an Android back handler while mounted and `active`; return `true` if
 * handled. No-op outside native (see `useOverlayBack` for browser back).
 */
export function useAndroidBack(handler: BackHandler, active = true): void {
  // Latest handler in a ref, so one stable stack entry is registered.
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
 * Browser back for overlays: while any overlay is open, ONE guard history entry
 * sits on top; back pops it and runs the topmost overlay's handler (which may
 * re-push to unwind a layer). An overlay closed otherwise pops its guard, deferred
 * a task so a close-and-navigate lands first; a guard left buried is skipped once.
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
 * Back handling for an overlay: back closes (or unwinds) it instead of navigating.
 * Native uses `useAndroidBack`; browsers hold a history entry while `active`.
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
