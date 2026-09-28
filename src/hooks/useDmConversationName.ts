/**
 * Display name of a DM conversation from every participant, via the shared
 * `['author', pubkey]` cache. `useQueries` handles a participant set that changes between
 * renders. `metadata`/`emojiTags` are only set for a 1:1.
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
  names: string[];
  metadata: NostrMetadata | undefined;
  /** Kind-0 tags for NIP-30 emoji in the name; returned here so each profile resolves once per row. */
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
