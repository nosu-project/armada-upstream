import { useMemo, useRef, type ReactNode } from "react";
import { useLocation, useNavigate, type Location, type NavigateFunction } from "react-router-dom";

import { LocationRefContext, type RouterRefs } from "@/lib/locationRef";

/**
 * Publishes the router location and `navigate` through
 * {@link LocationRefContext}. This is the ONE subscriber: it re-renders on
 * navigation, but `children` is a prop, so nothing below re-renders with it.
 * Render inside the router.
 */
export function LocationRefProvider({ children }: { children: ReactNode }) {
  const location = useLocation();
  const navigate = useNavigate();
  const locationRef = useRef<Location | undefined>(location);
  const navigateRef = useRef<NavigateFunction | undefined>(navigate);
  locationRef.current = location;
  navigateRef.current = navigate;
  const value = useMemo<RouterRefs>(() => ({ location: locationRef, navigate: navigateRef }), []);
  return <LocationRefContext.Provider value={value}>{children}</LocationRefContext.Provider>;
}
