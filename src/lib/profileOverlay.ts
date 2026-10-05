import { createContext } from "react";

import { resolvePubkey } from "@/lib/resolvePubkey";

import type { Location } from "react-router-dom";

/**
 * The profile route replaces the chat route, so closing it would remount the whole
 * page (expensive for Concord). A profile opened FROM somewhere carries
 * `backgroundLocation` (React Router's routed-modal idiom), so the page stays
 * mounted underneath. An optimization only: a cold `/<npub>` has no background.
 * Nested opens thread the ORIGINAL background through rather than restacking.
 */
export interface ProfileBackgroundState {
  backgroundLocation?: Location;
}

export interface ProfileOverlay {
  /** The profile the ROUTE names — set once the navigation has committed. */
  pubkey?: string;
  /**
   * A profile was requested and navigation hasn't landed. `navigate()` runs in
   * `startTransition` (React Router v7), which would hold a navigation-driven
   * spinner until it's useless; the click sets this first as an urgent update.
   */
  opening: boolean;
  /** Call synchronously from the click, BEFORE navigating. */
  begin: () => void;
}

/**
 * The profile drawing over the app. Provided by `AppRouter` (the only place
 * that sees the real location under `<Routes location={background}>`),
 * consumed by `MainLayout`.
 */
export const ProfileOverlayContext = createContext<ProfileOverlay>({
  opening: false,
  begin: () => {},
});

/**
 * Pubkey for a bare single-segment NIP-19 profile path (via `resolvePubkey`).
 * NIP-05 paths need a fetch, so they take the ordinary `UserPage` route.
 */
export function profileOverlayPubkey(pathname: string): string | undefined {
  const segments = pathname.split("/").filter(Boolean);
  if (segments.length !== 1) return undefined;
  return resolvePubkey(segments[0]);
}
