import { useCallback, useContext } from "react";
import { UNSAFE_NavigationContext, type Location } from "react-router-dom";

import { useCurrentUser } from "@/hooks/useCurrentUser";
import { LocationRefContext } from "@/lib/locationRef";
import { ProfileOverlayContext } from "@/lib/profileOverlay";

import type { ProfileBackgroundState } from "@/lib/profileOverlay";

/**
 * Open a profile at `/<npub>` over the current page (see `lib/profileOverlay.ts`). The
 * background is attached only when signed in (signed out, it's the share/invite screen). Stable
 * identity: reads the location at call time (`lib/locationRef.ts`) since every message row calls it.
 */
export function useOpenProfile() {
  const router = useContext(LocationRefContext);
  // Doesn't subscribe to the location, unlike `useNavigate`.
  const { navigator } = useContext(UNSAFE_NavigationContext);
  const { user } = useCurrentUser();
  const { begin } = useContext(ProfileOverlayContext);

  return useCallback(
    (id: string) => {
      const navigate = (to: string, state?: unknown) => {
        const routerNavigate = router?.navigate.current;
        if (routerNavigate) routerNavigate(to, { state });
        else navigator.push(to, state);
      };
      if (!user) {
        navigate(`/${id}`);
        return;
      }
      // Order matters: `navigate` runs in a transition, so this urgent update paints first.
      begin();
      // Keep the ORIGINAL background when opening a profile from a profile.
      const location = router?.location.current ?? windowLocation();
      const current = (location.state as ProfileBackgroundState | null)?.backgroundLocation;
      navigate(`/${id}`, { backgroundLocation: current ?? location });
    },
    [router, navigator, user, begin],
  );
}

/** Outside a `LocationRefProvider`: the address bar, with no router state. */
function windowLocation(): Location {
  const { pathname, search, hash } = window.location;
  return { pathname, search, hash, state: null, key: "default" };
}
