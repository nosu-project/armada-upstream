import { useNostr } from "@nostrify/react";
import { useCallback, useEffect, useMemo, useRef, useSyncExternalStore } from "react";

import { useLiveCommunities } from "@/concord/hooks/useCommunityList";
import { rehydrateCommunity } from "@/concord/lib/communityList";
import {
  attemptGuestbookJoin,
  getPendingGuestbookJoin,
  isGuestbookJoinInFlight,
  pendingGuestbookJoinsFor,
  pendingGuestbookJoinsReady,
  subscribePendingGuestbookJoins,
} from "@/concord/lib/pendingGuestbookJoin";
import { useCurrentUser } from "@/hooks/useCurrentUser";

import type { Community } from "@/concord/lib/types";

/** How often due Joins are looked for; each record keeps its own backoff. */
const RESUME_TICK_MS = 30_000;

/**
 * Retry this account's unpublished Guestbook Joins: when the records or the
 * community list load, when the browser comes back online, and on a timer, each
 * after its own backoff. A community not in the live list is skipped, never
 * forgotten: an unloaded list reads empty, and Leave forgets its own Join.
 */
export function useResumeGuestbookJoins(): void {
  const { nostr } = useNostr();
  const { user } = useCurrentUser();
  const live = useLiveCommunities();
  const ctx = useRef({ nostr, user, live });
  ctx.current = { nostr, user, live };
  const viewer = user?.pubkey;
  const runRef = useRef<(force?: boolean) => void>(() => {});

  useEffect(() => {
    if (!viewer) return;
    let cancelled = false;
    const run = (force = false) => {
      const { nostr: pool, user: u, live: entries } = ctx.current;
      if (cancelled || !u || u.pubkey !== viewer) return;
      const now = Date.now();
      for (const rec of pendingGuestbookJoinsFor(viewer)) {
        if (!force && rec.nextAttemptAt > now) continue;
        const entry = entries.find((e) => e.community_id === rec.communityIdHex);
        const community = entry ? rehydrateCommunity(entry) : undefined;
        if (community) void attemptGuestbookJoin(pool, community, u.signer, viewer);
      }
    };
    runRef.current = run;
    void pendingGuestbookJoinsReady().then(() => run());
    const online = () => run(true);
    window.addEventListener("online", online);
    const timer = setInterval(() => run(), RESUME_TICK_MS);
    return () => {
      cancelled = true;
      window.removeEventListener("online", online);
      clearInterval(timer);
      runRef.current = () => {};
    };
  }, [viewer]);

  // After a reload the records usually load before the community list does, and
  // a Join whose community isn't listed yet is skipped: run again once it is.
  const liveIds = useMemo(() => live.map((e) => e.community_id).join(","), [live]);
  useEffect(() => {
    if (liveIds) void pendingGuestbookJoinsReady().then(() => runRef.current());
  }, [liveIds]);
}

export type PendingJoinState = "signing" | "sending" | "failed";

/**
 * This community's unpublished Join, if any: `signing` while the signer is
 * asked, `sending` while a sealed Join is out, `failed` between attempts.
 */
export function usePendingGuestbookJoin(community: Community | undefined): {
  state: PendingJoinState | undefined;
  retry: () => void;
} {
  const { nostr } = useNostr();
  const { user } = useCurrentUser();
  const viewer = user?.pubkey;
  const id = community?.idHex;
  const snapshot = useCallback(() => {
    if (!viewer || !id) return undefined;
    const rec = getPendingGuestbookJoin(viewer, id);
    if (!rec) return undefined;
    if (isGuestbookJoinInFlight(viewer, id)) return rec.wrap ? "sending" : "signing";
    return "failed";
  }, [viewer, id]);
  const state = useSyncExternalStore(subscribePendingGuestbookJoins, snapshot, snapshot);

  const ctx = useRef({ nostr, user, community });
  ctx.current = { nostr, user, community };
  const retry = useCallback(() => {
    const { nostr: pool, user: u, community: c } = ctx.current;
    if (u && c) void attemptGuestbookJoin(pool, c, u.signer, u.pubkey);
  }, []);

  return useMemo(() => ({ state, retry }), [state, retry]);
}
