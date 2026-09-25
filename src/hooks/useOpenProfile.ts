import { useCallback, useContext } from "react";
import { UNSAFE_NavigationContext, type Location } from "react-router-dom";

import { useCurrentUser } from "@/hooks/useCurrentUser";
import { LocationRefContext } from "@/lib/locationRef";
import { ProfileOverlayContext } from "@/lib/profileOverlay";

import type { ProfileBackgroundState } from "@/lib/profileOverlay";

/**
 * Open someone's profile at `/<npub>`, keeping the page you're on mounted
 * underneath it. See `lib/profileOverlay.ts` for why that matters.
 *
 * Takes an npub/nprofile/hex id and navigates to the bare NIP-19 path — the
 * one Nostr clients share — so a copied URL is the same link either way.
 *
 * The background is only attached for a SIGNED-IN viewer. Signed out, the same
 * path is the share/invite screen rather than a profile, and that is a
 * destination in its own right: drawing it over the page someone was reading
 * would be a modal asking them to make an account, on top of the thing they
 * came to look at.
 *
 * The returned function keeps ONE identity across navigations: it reads the
 * location at call time (see `lib/locationRef.ts`) rather than subscribing to
 * it, because every chat message row calls this hook.
 */
export function useOpenProfile() {
  const router = useContext(LocationRefContext);
  // Only the no-provider fallback uses this; the context is stable, and unlike
  // `useNavigate` it does not subscribe to the location.
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
      // Order matters. `navigate` runs inside `startTransition`, so everything
      // it causes — the profile AND any spinner rendered from it — is held
      // until React can commit the finished result. This is an ordinary urgent
      // update, so it paints in a pass of its own first, which is the only
      // reason the click has any immediate effect at all.
      begin();
      // Thread the ORIGINAL background through a profile opened from inside a
      // profile, so the page underneath stays the chat rather than becoming
      // the profile we're leaving.
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
