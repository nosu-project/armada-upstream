import { createContext } from "react";

import { resolvePubkey } from "@/lib/resolvePubkey";

import type { Location } from "react-router-dom";

/**
 * The profile route (`/<npub>`) is a sibling of every chat route, so visiting
 * it plainly UNMOUNTS whatever was open — and closing it mounts that page
 * again from nothing: its hook chain, its timeline prewarm, its group-key
 * derivation and its IndexedDB reads. For a Concord community that is the
 * single most expensive thing the client does, and paying it to glance at
 * someone's avatar is what made opening a profile and closing it feel like a
 * cold start.
 *
 * So a profile opened FROM somewhere carries where it came from
 * (`backgroundLocation`, the React Router idiom for a routed modal). The
 * router keeps rendering that location, the profile draws over it, and closing
 * is a history step that reveals a page which never went away.
 *
 * Two things follow, and both are deliberate:
 *
 * - It is an OPTIMIZATION, not the contract. A `/<npub>` reached cold — pasted,
 *   shared, reloaded — has no background, and then `UserPage` renders it as an
 *   ordinary route exactly as before. Nothing may depend on the background
 *   being there.
 * - The background is threaded THROUGH nested opens rather than restacked. A
 *   profile opened from inside another profile keeps the original chat behind
 *   it, so closing two levels of profile never leaves a profile as the page
 *   underneath.
 */
export interface ProfileBackgroundState {
  backgroundLocation?: Location;
}

/**
 * The pubkey whose profile is drawing over the app, or `undefined`. Provided by
 * `AppRouter` — which is the only place that can see the REAL location, since
 * `<Routes location={background}>` rewrites `useLocation()` for everything
 * below it — and consumed by `MainLayout`, which owns the pane it draws in.
 */
export const ProfileOverlayContext = createContext<string | undefined>(undefined);

/**
 * The pubkey a path names, if it is a bare single-segment NIP-19 profile path.
 *
 * Only what `resolvePubkey` decodes counts, which is what keeps `/dm`,
 * `/settings` and every other one-segment route from being read as a person.
 * A NIP-05 address (`/alex@gleasonator.dev`) deliberately doesn't resolve here
 * — it needs a well-known fetch, so it takes the ordinary `UserPage` route.
 */
export function profileOverlayPubkey(pathname: string): string | undefined {
  const segments = pathname.split("/").filter(Boolean);
  if (segments.length !== 1) return undefined;
  return resolvePubkey(segments[0]);
}
