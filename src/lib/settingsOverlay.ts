import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from "react";

import type { ProfileBackgroundState } from "@/lib/profileOverlay";
import type { Location, NavigateFunction } from "react-router-dom";

/**
 * Settings, opened from inside the app, draws OVER the page it was opened
 * from instead of replacing it — the same arrangement as the profile overlay
 * (`lib/profileOverlay.ts`), for the same reason and one more.
 *
 * The same reason: `/settings` is a sibling of every chat route, so visiting
 * it plainly unmounts the open community and closing it rebuilds that page
 * from nothing. With a `backgroundLocation` the routes keep matching the page
 * underneath, and closing is a history step back to a page that never left.
 *
 * The one more: `navigate()` is a transition, and a transition is INTERRUPTIBLE
 * — every urgent update restarts it. In a busy community each arriving event
 * is one, so the more traffic there was, the longer Settings took to appear
 * and to go away. So visibility is not taken from the navigation at all. The
 * click sets it as an ordinary urgent update, which paints on its own; the
 * navigation follows only to keep the URL (and the back button) truthful.
 *
 * A `/settings` reached cold — a reload with no history state, a pasted link —
 * has no background and is routed as an ordinary page, exactly as before.
 */
export interface SettingsOverlay {
  /** Settings is drawing over the page — from the click, not from the commit. */
  open: boolean;
  /** The section to expand and scroll to (`/settings#<section>`), or "". */
  section: string;
  /** Open over the current page. Safe to call while already open. */
  show: (section?: string) => void;
  /** Close, stepping back to the page underneath. */
  close: () => void;
}

export const SETTINGS_PATH = "/settings";

export const SettingsOverlayContext = createContext<SettingsOverlay>({
  open: false,
  section: "",
  show: () => {},
  close: () => {},
});

/**
 * Whether Settings is drawing over the routed page. The page stays mounted
 * under it but is not on screen: it must not report its conversation as the
 * one being looked at (which silences that conversation's notifications) nor
 * advance its read markers until Settings closes again.
 */
export function usePageCovered(): boolean {
  return useContext(SettingsOverlayContext).open;
}

/** What the click asked for, until the navigation it started has landed. */
interface Pending {
  open: boolean;
  section: string;
}

/**
 * The provider's state. Called by `AppRoutes`, the one place that sees the
 * REAL location (`<Routes location={background}>` rewrites it below).
 */
export function useSettingsOverlayController(
  location: Location,
  navigate: NavigateFunction,
): SettingsOverlay {
  const background = (location.state as ProfileBackgroundState | null)?.backgroundLocation;
  const routed = !!background && location.pathname === SETTINGS_PATH;

  const [pending, setPending] = useState<Pending | null>(null);

  // Read at call time so `show`/`close` keep one identity: they are handed to
  // the always-mounted rail, and the context value is memoized on them.
  const refs = useRef({ location, navigate, routed, pending });
  refs.current = { location, navigate, routed, pending };

  // History moves this controller started that the rendered location hasn't
  // caught up with. The history entry itself changes at once — only the render
  // lags — so a second press before the first lands must build on the entry
  // that is really there, not the one on screen: a second push would stack
  // two `/settings` entries, and one step back would leave Settings open.
  const inFlight = useRef<"push" | "back" | null>(null);

  const push = useCallback((section: string, replace: boolean) => {
    const { location, navigate } = refs.current;
    const to = section ? `${SETTINGS_PATH}#${section}` : SETTINGS_PATH;
    // Thread a profile's background through, so the page underneath stays the
    // chat rather than becoming the profile being left.
    const current = (location.state as ProfileBackgroundState | null)?.backgroundLocation;
    const state: ProfileBackgroundState = { backgroundLocation: current ?? location };
    navigate(to, { state, replace });
    if (!replace) inFlight.current = "push";
  }, []);

  // Any landed navigation settles the click, unless it landed on the wrong
  // side of it. A close that beat its own open: the open is a transition that
  // lands regardless, so step back off it the moment it does. An open that
  // beat its close's step back: the step can't be recalled either, so open
  // again from where it lands.
  useEffect(() => {
    const { pending, routed, navigate } = refs.current;
    const settled = inFlight.current;
    inFlight.current = null;
    if (pending && !pending.open && routed) {
      navigate(-1);
      inFlight.current = "back";
      return;
    }
    if (pending && pending.open && !routed && settled === "back") {
      push(pending.section, false);
      return;
    }
    setPending(null);
  }, [location, push]);

  const show = useCallback((section = "") => {
    const { location, navigate, routed } = refs.current;
    // Already ON the routed Settings page: there is nothing underneath to
    // draw over, so just move to the section.
    if (!routed && location.pathname === SETTINGS_PATH && !inFlight.current) {
      navigate(section ? `${SETTINGS_PATH}#${section}` : SETTINGS_PATH, { replace: true });
      return;
    }
    setPending({ open: true, section });
    // Stepping back from a close: re-opened where that step lands (above).
    if (inFlight.current === "back") return;
    // Already over a page, or about to be: move within Settings without
    // another history entry, so one step back still closes it.
    push(section, routed || inFlight.current === "push");
  }, [push]);

  const close = useCallback(() => {
    const { routed, navigate } = refs.current;
    setPending({ open: false, section: "" });
    // A step back already under way, or an open still landing (stepped back
    // off once it has): either way there is no entry here to leave yet.
    if (inFlight.current) return;
    if (routed) {
      navigate(-1);
      inFlight.current = "back";
    }
  }, []);

  const open = pending ? pending.open : routed;
  const section = pending?.open ? pending.section : routed ? location.hash.slice(1) : "";

  return useMemo(() => ({ open, section, show, close }), [open, section, show, close]);
}
