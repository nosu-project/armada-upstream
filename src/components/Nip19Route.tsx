import { lazy } from "react";
import { useParams } from "react-router-dom";

import { lazyWithReload } from "@/lib/chunkReload";

const NaddrPage = lazy(lazyWithReload(() => import("@/pages/NaddrPage").then((m) => ({ default: m.NaddrPage }))));
const UserPage = lazy(lazyWithReload(() => import("@/pages/UserPage").then((m) => ({ default: m.UserPage }))));

/**
 * Dispatch a bare `/<segment>` — the NIP-19 convention Ditto routes the same
 * way. An `naddr` is a shared addressable event (a theme, an emoji pack) and
 * gets its own page; anything else is a person, and `UserPage` renders the 404
 * itself for a segment that names nobody.
 */
export function Nip19Route() {
  const { user: segment } = useParams<{ user: string }>();
  return segment && /^naddr1/i.test(segment) ? <NaddrPage /> : <UserPage />;
}
