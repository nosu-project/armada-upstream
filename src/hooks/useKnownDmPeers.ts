import { useCallback, useMemo } from "react";

import { useAcceptedDms } from "@/hooks/useAcceptedDms";
import {
  useDmConversationIndex,
  useDmConversationIndexReady,
} from "@/hooks/useDmConversationIndex";
import { useFollowList } from "@/hooks/useFollowList";
import { useMutedPubkeys } from "@/hooks/useMuteList";
import { usePinnedDms } from "@/hooks/usePinnedDms";
import { dmConvPeers } from "@/lib/nip17/protocol";

const PUBKEY_RE = /^[0-9a-f]{64}$/;

export interface UseKnownDmPeersReturn {
  /**
   * Whether a conversation belongs in the main DM list rather than the request
   * tier. `mine` is the cross-plane "the viewer has authored a message in this
   * conversation" flag (see `useDMConversations` / `queryDm17Conversations`).
   */
  isKnown: (peer: string, mine: boolean) => boolean;
  /** Every individual peer whose legacy DM history may be restored. */
  knownPeers: string[];
  /** Exact unmuted NIP-17 conversation keys the viewer pinned or wrote in. */
  knownConversationKeys: string[];
  /** Muted peers; existing DM semantics hide any group containing one. */
  mutedPeers: string[];
  /** True until follows, mutes and the encrypted conversation index have resolved. */
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
 *   - the viewer pinned their 1:1 conversation (an explicit "keep this one"
 *     that must outlive an unfollow);
 *   - a synced conversation-index row proves the viewer previously wrote in
 *     that conversation.
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
 * Note this only decides PLACEMENT. Muted peers are rejected here as well as
 * upstream so background fetch/notification consumers stay silent; and on the
 * legacy kind-4 plane strangers are never fetched at all (`buildDmFilters`
 * scopes the received direction to this established set), so requests are in
 * practice a NIP-17 phenomenon.
 */
export function useKnownDmPeers(): UseKnownDmPeersReturn {
  const { data: followData, isLoading: followsLoading } = useFollowList();
  const { accepted } = useAcceptedDms();
  const { pinned } = usePinnedDms();
  const indexed = useDmConversationIndex();
  const indexReady = useDmConversationIndexReady();
  const { mutedPubkeys, ready: mutesReady } = useMutedPubkeys();

  const knownPeers = useMemo(() => {
    // Fail closed while the encrypted mute list is unresolved: this roster is
    // consumed by background subscriptions/notifications, where the UI's
    // ordinary render-time mute filter cannot protect the user.
    if (!mutesReady) return [];
    const peers = new Set(
      (followData?.pubkeys ?? []).filter(
        (peer) => PUBKEY_RE.test(peer) && !mutedPubkeys.has(peer),
      ),
    );
    for (const peer of accepted) {
      if (PUBKEY_RE.test(peer) && !mutedPubkeys.has(peer)) peers.add(peer);
    }
    // A group pin orders that exact conversation; it does not implicitly trust
    // every participant. A 1:1 pin does identify one trusted peer.
    for (const key of pinned) {
      const participants = dmConvPeers(key);
      if (participants.length === 1
        && PUBKEY_RE.test(participants[0])
        && !mutedPubkeys.has(participants[0])) peers.add(participants[0]);
    }
    // `mine` in a 1:1 is durable evidence that this account wrote to that peer.
    // A group row proves participation in THAT group, not that every member's
    // unrelated 1:1 messages are trusted, so group participants never widen
    // the global legacy-author/notification allow-list here.
    for (const record of indexed) {
      if (!record.mine) continue;
      const participants = dmConvPeers(record.key);
      const peer = participants.length === 1 ? participants[0] : undefined;
      if (peer && PUBKEY_RE.test(peer) && !mutedPubkeys.has(peer)) peers.add(peer);
    }
    return [...peers].sort();
  }, [accepted, followData?.pubkeys, indexed, mutedPubkeys, mutesReady, pinned]);
  const knownSet = useMemo(() => new Set(knownPeers), [knownPeers]);

  const knownConversationKeys = useMemo(() => {
    if (!mutesReady) return [];
    const keys = new Set<string>();
    // A group pin is evidence for that exact room, never for unrelated 1:1s
    // with its participants. The same is true of an authored synced row.
    for (const key of pinned) {
      const peers = dmConvPeers(key);
      if (peers.length > 0 && peers.every((peer) =>
        PUBKEY_RE.test(peer) && !mutedPubkeys.has(peer))) keys.add(key);
    }
    for (const record of indexed) {
      if (!record.mine) continue;
      const peers = dmConvPeers(record.key);
      if (peers.length > 0 && peers.every((peer) =>
        PUBKEY_RE.test(peer) && !mutedPubkeys.has(peer))) keys.add(record.key);
    }
    return [...keys].sort();
  }, [indexed, mutedPubkeys, mutesReady, pinned]);

  const mutedPeers = useMemo(
    () => mutesReady ? [...mutedPubkeys].filter((peer) => PUBKEY_RE.test(peer)).sort() : [],
    [mutedPubkeys, mutesReady],
  );

  const isKnown = useCallback(
    (peer: string, mine: boolean) => !mutedPubkeys.has(peer) && (mine || knownSet.has(peer)),
    [knownSet, mutedPubkeys],
  );

  return {
    isKnown,
    knownPeers,
    knownConversationKeys,
    mutedPeers,
    isLoading: followsLoading || !indexReady || !mutesReady,
  };
}
