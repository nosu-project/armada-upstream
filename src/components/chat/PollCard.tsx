import { useNostr } from "@nostrify/react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useMemo } from "react";

import { PollView } from "@/components/chat/PollView";
import { useCurrentUser } from "@/hooks/useCurrentUser";
import { useNostrPublish } from "@/hooks/useNostrPublish";
import { KIND_POLL_VOTE, parsePoll, tallyPollVotes, type PollVote } from "@/lib/polls";

import type { NostrRumor } from "@/lib/nostrRumor";

interface PollCardProps {
  /** The kind 1068 poll event. */
  event: NostrRumor;
  /** The group's host relay (votes are published and queried there). */
  relayUrl: string;
  /** The NIP-29 group id, added as an `h` tag on votes. */
  groupId: string;
  /** Whether the current user may vote (group membership). */
  canVote: boolean;
}

/**
 * NIP-29 poll container: fetches the poll's votes from the group's host relay,
 * tallies them with the shared logic, and publishes votes as kind-1018 events.
 * Rendering is delegated to the transport-agnostic {@link PollView}.
 */
export function PollCard({ event, relayUrl, groupId, canVote }: PollCardProps) {
  const { nostr } = useNostr();
  const { user } = useCurrentUser();
  const { mutateAsync: createEvent } = useNostrPublish();
  const queryClient = useQueryClient();
  const { options, endsAt } = useMemo(() => parsePoll(event), [event]);

  const votesQuery = useQuery({
    queryKey: ["poll-votes", relayUrl, event.id],
    queryFn: async ({ signal }) => {
      return await nostr.relay(relayUrl).query(
        [{ kinds: [KIND_POLL_VOTE], "#e": [event.id], limit: 500 }],
        { signal: AbortSignal.any([signal, AbortSignal.timeout(8000)]) },
      );
    },
    staleTime: 15_000,
    refetchInterval: 30_000,
  });

  const tally = useMemo(() => {
    const votes: PollVote[] = (votesQuery.data ?? []).map((v) => ({
      pubkey: v.pubkey,
      optionIds: v.tags.filter(([n, val]) => n === "response" && val).map(([, val]) => val),
      ms: v.created_at * 1000,
    }));
    return tallyPollVotes(votes, options, endsAt, user?.pubkey);
  }, [votesQuery.data, options, endsAt, user]);

  const vote = useMutation({
    mutationFn: async (optionIds: string[]) => {
      await createEvent({
        kind: KIND_POLL_VOTE,
        content: "",
        tags: [
          ["e", event.id],
          ["h", groupId],
          ...optionIds.map((id) => ["response", id]),
        ],
        relay: relayUrl,
      });
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["poll-votes", relayUrl, event.id] });
    },
  });

  return (
    <PollView
      event={event}
      tally={tally}
      canVote={canVote}
      isVoting={vote.isPending}
      onVote={(optionIds) => vote.mutate(optionIds)}
    />
  );
}
