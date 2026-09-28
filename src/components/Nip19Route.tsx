import { lazy } from "react";
import { useParams } from "react-router-dom";

import { lazyWithReload } from "@/lib/chunkReload";

const NaddrPage = lazy(lazyWithReload(() => import("@/pages/NaddrPage").then((m) => ({ default: m.NaddrPage }))));
const UserPage = lazy(lazyWithReload(() => import("@/pages/UserPage").then((m) => ({ default: m.UserPage }))));

/** Dispatch a bare NIP-19 `/<segment>`: `naddr` gets its own page, anything else is a person (`UserPage` 404s). */
export function Nip19Route() {
  const { user: segment } = useParams<{ user: string }>();
  return segment && /^naddr1/i.test(segment) ? <NaddrPage /> : <UserPage />;
}
