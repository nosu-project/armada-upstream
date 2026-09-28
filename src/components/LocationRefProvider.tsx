import { useMemo, useRef, type ReactNode } from "react";
import { useLocation, useNavigate, type Location, type NavigateFunction } from "react-router-dom";

import { LocationRefContext, type RouterRefs } from "@/lib/locationRef";

/**
 * Publishes router location and `navigate` via {@link LocationRefContext}; the
 * ONE subscriber, so `children` (a prop) don't re-render on navigation.
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
