import { useCallback } from "react";
import { useLocation, useNavigate } from "react-router-dom";

import { useCurrentUser } from "@/hooks/useCurrentUser";

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
 */
export function useOpenProfile() {
  const navigate = useNavigate();
  const location = useLocation();
  const { user } = useCurrentUser();

  return useCallback(
    (id: string) => {
      if (!user) {
        navigate(`/${id}`);
        return;
      }
      // Thread the ORIGINAL background through a profile opened from inside a
      // profile, so the page underneath stays the chat rather than becoming
      // the profile we're leaving.
      const current = (location.state as ProfileBackgroundState | null)?.backgroundLocation;
      navigate(`/${id}`, { state: { backgroundLocation: current ?? location } });
    },
    [navigate, location, user],
  );
}
