import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from "react";

import type { ProfileBackgroundState } from "@/lib/profileOverlay";
import type { Location, NavigateFunction } from "react-router-dom";

/**
 * Settings opened in-app draws OVER the page via `backgroundLocation` (like
 * `lib/profileOverlay.ts`), so the page underneath stays mounted. Visibility
 * comes from the click as an urgent update, not the navigation: `navigate()`
 * is an interruptible transition that busy communities kept restarting.
 * A cold `/settings` (reload, pasted link) routes as an ordinary page.
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
 * Whether Settings covers the routed page. A covered page must not claim its
 * conversation as viewed (silencing notifications) or advance read markers.
 */
export function usePageCovered(): boolean {
  return useContext(SettingsOverlayContext).open;
}

/** What the click asked for, until the navigation it started has landed. */
interface Pending {
  open: boolean;
  section: string;
}

/** Called by `AppRoutes`, the one place that sees the REAL location. */
export function useSettingsOverlayController(
  location: Location,
  navigate: NavigateFunction,
): SettingsOverlay {
  const background = (location.state as ProfileBackgroundState | null)?.backgroundLocation;
  const routed = !!background && location.pathname === SETTINGS_PATH;

  const [pending, setPending] = useState<Pending | null>(null);

  // Read at call time so `show`/`close` keep a stable identity.
  const refs = useRef({ location, navigate, routed, pending });
  refs.current = { location, navigate, routed, pending };

  // History moves not yet rendered. A second press must build on the real
  // history entry, or two `/settings` pushes would stack.
  const inFlight = useRef<"push" | "back" | null>(null);

  const push = useCallback((section: string, replace: boolean) => {
    const { location, navigate } = refs.current;
    const to = section ? `${SETTINGS_PATH}#${section}` : SETTINGS_PATH;
    // Thread a profile's background through so the chat stays underneath.
    const current = (location.state as ProfileBackgroundState | null)?.backgroundLocation;
    const state: ProfileBackgroundState = { backgroundLocation: current ?? location };
    navigate(to, { state, replace });
    if (!replace) inFlight.current = "push";
  }, []);

  // A landed navigation settles the click, unless it landed on the wrong side:
  // a close that beat its open steps back once the open lands; an open that
  // beat its close's step back re-opens from where it lands.
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
    // On the routed Settings page itself: just move to the section.
    if (!routed && location.pathname === SETTINGS_PATH && !inFlight.current) {
      navigate(section ? `${SETTINGS_PATH}#${section}` : SETTINGS_PATH, { replace: true });
      return;
    }
    setPending({ open: true, section });
    if (inFlight.current === "back") return;
    // Already over a page (or about to be): replace, so one step back still closes.
    push(section, routed || inFlight.current === "push");
  }, [push]);

  const close = useCallback(() => {
    const { routed, navigate } = refs.current;
    setPending({ open: false, section: "" });
    // A back step or an open is still landing; the effect above resolves it.
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
