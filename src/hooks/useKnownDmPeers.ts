import { useCallback, useMemo } from "react";

import { useAcceptedDms } from "@/hooks/useAcceptedDms";
import { useFollowList } from "@/hooks/useFollowList";
import { usePinnedDms } from "@/hooks/usePinnedDms";

export interface UseKnownDmPeersReturn {
  /**
   * Whether a conversation belongs in the main DM list rather than the request
   * tier. `mine` is the cross-plane "the viewer has authored a message in this
   * conversation" flag (see `useDMConversations` / `queryDm17Conversations`).
   */
  isKnown: (peer: string, mine: boolean) => boolean;
  /** True until the follow list has resolved. */
  isLoading: boolean;
}

/**
 * The single "is this DM peer known?" predicate, shared by every surface that
 * has to draw the line between the inbox and the request tier: the list, the
 * request list, the rail's unread dot, and the thread's request notice.
 *
 * A peer is known when ANY of these hold:
 *
 *   - the viewer follows them (kind 3);
 *   - the viewer has written to them (`mine`) — replying is accepting;
 *   - a reply/compose recorded them in `acceptedDms`, which is just `mine`
 *     without the conversation-query lag (there is no accept button);
 *   - the viewer pinned them (an explicit "keep this one" that must outlive an
 *     unfollow).
 *
 * Everything else is a request. This is deliberately a pure function of
 * persisted state and carries no view concerns — the DM list separately keeps
 * whichever thread is currently OPEN on screen, which is a rendering rule, not
 * a trust one.
 *
 * It must stay the only implementation. Two surfaces disagreeing about who is
 * known puts a conversation in both lists or in neither, and makes the unread
 * dot light for a row the list won't show.
 *
 * Note this only decides PLACEMENT. Muted peers are dropped upstream in both
 * DM planes and never reach it; and on the legacy kind-4 plane strangers are
 * never fetched at all (`buildDmFilters` scopes the received direction to
 * follows), so requests are in practice a NIP-17 phenomenon.
 */
export function useKnownDmPeers(): UseKnownDmPeersReturn {
  const { data: followData, isLoading } = useFollowList();
  const { isAccepted } = useAcceptedDms();
  const { isPinned } = usePinnedDms();

  const followed = useMemo(
    () => new Set(followData?.pubkeys ?? []),
    [followData?.pubkeys],
  );

  const isKnown = useCallback(
    (peer: string, mine: boolean) =>
      mine || followed.has(peer) || isAccepted(peer) || isPinned(peer),
    [followed, isAccepted, isPinned],
  );

  return { isKnown, isLoading };
}
