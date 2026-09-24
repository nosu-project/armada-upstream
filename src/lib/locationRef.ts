import { createContext, type RefObject } from "react";

import type { Location, NavigateFunction } from "react-router-dom";

/**
 * The router's current location and `navigate`, as REFS that never change
 * identity.
 *
 * `useLocation()` subscribes its caller to every navigation, and so does
 * `useNavigate()` (it resolves relative paths against the location). That is
 * right for something that renders from the location, and wasteful for
 * something that only needs it inside a click handler — `useOpenProfile` is
 * called by every chat message row, and subscribing each of them re-rendered
 * every mounted row on every route change (a conversation switch re-rendered
 * the whole thread it was leaving). Read `.current` at call time instead.
 *
 * `null` outside `LocationRefProvider` (tests that mount a bare component).
 */
export interface RouterRefs {
  location: RefObject<Location | undefined>;
  navigate: RefObject<NavigateFunction | undefined>;
}

export const LocationRefContext = createContext<RouterRefs | null>(null);
