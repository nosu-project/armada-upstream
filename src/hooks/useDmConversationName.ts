/**
 * The display name of a DM conversation, resolved from every participant.
 *
 * A 1:1 needed one profile; a group needs all of them, and it needs them the
 * same way the row already resolves one — store-first through the shared
 * `['author', pubkey]` cache, with the network half declared to the profile
 * sync topic. `useQueries` is how that generalizes without a hook per
 * participant: the participant set can change between renders (opening a
 * different conversation, a group gaining a member) and `useQueries` takes the
 * list as data rather than as call sites.
 *
 * `metadata` is returned alongside the name for the 1:1 case, whose row still
 * wants the avatar shape and the bot pill from that one profile. A group has no
 * single profile to take either from, so it is undefined there.
 */

import { useNostr } from "@nostrify/react";
import { useQueries, useQueryClient } from "@tanstack/react-query";
import { useEffect, useMemo } from "react";

import { authorQueryOptions, type AuthorResult } from "@/hooks/useAuthor";
import { useEventStore } from "@/hooks/useEventStore";
import { NOTE_TO_SELF_NAME } from "@/components/NoteToSelfAvatar";
import {
  dmConversationName,
  dmConversationSearchText,
  dmParticipantNames,
} from "@/lib/dmConversation";
import { demandProfiles } from "@/sync/profileSync";

import type { NostrMetadata } from "@nostrify/nostrify";

export interface DmConversationName {
  /** "Derek Ross, Mary Kate Fain" — or one name, or "Note to Self". */
  name: string;
  /** Every participant's name/display-name/NIP-05/pubkey alias for launchers. */
  searchText: string;
  /** Each participant's name, in the conversation's own (sorted) order. */
  names: string[];
  /** The single participant's profile, for a 1:1 only. */
  metadata: NostrMetadata | undefined;
  /**
   * The single participant's kind-0 tags, for a 1:1 only — what resolves NIP-30
   * custom emoji in their display name.
   *
   * Returned from here rather than left to the caller's own `useAuthor` so a
   * conversation row resolves each profile ONCE. A row already pays a profile
   * query per participant through the avatar; a second lookup for the same
   * pubkey doubled that on every row of the list.
   */
  emojiTags: string[][] | undefined;
}

export function useDmConversationName(
  peers: readonly string[],
  selfPubkey: string | undefined,
): DmConversationName {
  const { nostr } = useNostr();
  const queryClient = useQueryClient();
  const eventStore = useEventStore();

  const peerKey = peers.join(",");
  const targets = useMemo(() => peers.slice(), [peerKey]); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    if (targets.length === 0) return;
    return demandProfiles(targets, { nostr, queryClient });
  }, [targets, nostr, queryClient]);

  const results = useQueries({
    queries: targets.map((peer) => authorQueryOptions(queryClient, eventStore, peer)),
  });

  // `useQueries` returns results positionally, so index N is `targets[N]`.
  const resultsKey = results.map((r) => r.dataUpdatedAt).join(",");
  const metadataByPeer = useMemo(() => {
    const out = new Map<string, NostrMetadata | undefined>();
    targets.forEach((peer, i) => {
      out.set(peer, (results[i]?.data as AuthorResult | undefined)?.metadata);
    });
    return out;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [peerKey, resultsKey]);
  const eventTagsByPeer = useMemo(() => {
    const out = new Map<string, string[][] | undefined>();
    targets.forEach((peer, i) => {
      out.set(peer, (results[i]?.data as AuthorResult | undefined)?.event?.tags);
    });
    return out;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [peerKey, resultsKey]);

  return useMemo(() => {
    // The conversation with yourself is Note to Self throughout, not a thread
    // with your own profile.
    if (targets.length === 1 && targets[0] === selfPubkey) {
      return {
        name: NOTE_TO_SELF_NAME,
        searchText: `${NOTE_TO_SELF_NAME} ${dmConversationSearchText(targets, (peer) => metadataByPeer.get(peer))}`,
        names: [NOTE_TO_SELF_NAME],
        metadata: undefined,
        emojiTags: undefined,
      };
    }
    const names = dmParticipantNames(targets, (peer) => metadataByPeer.get(peer));
    const single = targets.length === 1 ? targets[0] : undefined;
    return {
      name: dmConversationName(names),
      searchText: dmConversationSearchText(targets, (peer) => metadataByPeer.get(peer)),
      names,
      metadata: single ? metadataByPeer.get(single) : undefined,
      emojiTags: single ? eventTagsByPeer.get(single) : undefined,
    };
  }, [targets, selfPubkey, metadataByPeer, eventTagsByPeer]);
}
