import { useNostr } from "@nostrify/react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useMemo } from "react";

import { useCurrentUser } from "@/hooks/useCurrentUser";
import { useNostrPublish } from "@/hooks/useNostrPublish";
import { KIND_REACTION } from "@/lib/nip29";

import type { NostrEvent } from "@nostrify/nostrify";

/**
 * A NIP-25 reaction, identified by its display emoji. A `+` or empty content
 * is normalized to 👍 and `-` to 👎; custom NIP-30 emoji keep their
 * `:shortcode:` form and carry the image URL from the reaction's `emoji` tag.
 */
export interface ReactionTally {
  /** The normalized reaction key (emoji, 👍/👎, or `:shortcode:`). */
  key: string;
  /** Custom emoji image URL when the key is a `:shortcode:`. */
  url?: string;
  /** Number of distinct pubkeys that reacted with this key. */
  count: number;
  /** The distinct pubkeys that reacted with this key, in reaction order. */
  pubkeys: string[];
  /** Whether the current user reacted with this key. */
  mine: boolean;
  /** The current user's reaction event for this key (used to retract it). */
  mineEvent?: NostrEvent;
}

/** Normalize a kind 7 reaction's content into a display key. */
function reactionKey(event: NostrEvent): string {
  const content = event.content;
  if (content === "+" || content === "") return "👍";
  if (content === "-") return "👎";
  return content;
}

export interface ReactInput {
  /** The display key being toggled (emoji, 👍/👎, or `:shortcode:`). */
  key: string;
  /** Raw content to publish (e.g. `+`, the emoji, or `:shortcode:`). */
  content: string;
  /** Custom emoji image URL when reacting with a `:shortcode:`. */
  emojiUrl?: string;
}

/**
 * Load and toggle NIP-25 reactions (kind 7) for a single message inside a
 * NIP-29 group. Reactions are queried from and published to the group's host
 * relay only, mirroring polls and chat messages.
 */
export function useReactions(target: NostrEvent, relayUrl: string, groupId: string) {
  const { nostr } = useNostr();
  const { user } = useCurrentUser();
  const { mutateAsync: createEvent } = useNostrPublish();
  const queryClient = useQueryClient();
  const queryKey = ["reactions", relayUrl, target.id];

  const reactionsQuery = useQuery({
    queryKey,
    queryFn: async ({ signal }) => {
      return await nostr.relay(relayUrl).query(
        [{ kinds: [KIND_REACTION], "#e": [target.id], limit: 500 }],
        { signal: AbortSignal.any([signal, AbortSignal.timeout(8000)]) },
      );
    },
    staleTime: 15_000,
    refetchInterval: 30_000,
  });

  // One reaction per (pubkey, key); the latest event wins.
  const tallies = useMemo<ReactionTally[]>(() => {
    const latest = new Map<string, NostrEvent>();
    for (const reaction of reactionsQuery.data ?? []) {
      const key = `${reaction.pubkey}:${reactionKey(reaction)}`;
      const existing = latest.get(key);
      if (!existing || reaction.created_at > existing.created_at) {
        latest.set(key, reaction);
      }
    }

    const byKey = new Map<string, ReactionTally>();
    for (const reaction of latest.values()) {
      const key = reactionKey(reaction);
      const url = reaction.tags.find(([n]) => n === "emoji")?.[2];
      const tally = byKey.get(key) ?? { key, url, count: 0, pubkeys: [], mine: false };
      tally.count += 1;
      tally.pubkeys.push(reaction.pubkey);
      if (url && !tally.url) tally.url = url;
      if (user && reaction.pubkey === user.pubkey) {
        tally.mine = true;
        tally.mineEvent = reaction;
      }
      byKey.set(key, tally);
    }

    return [...byKey.values()].sort((a, b) => b.count - a.count);
  }, [reactionsQuery.data, user]);

  const react = useMutation({
    mutationFn: async ({ content, emojiUrl }: ReactInput) => {
      const tags: string[][] = [
        ["e", target.id],
        ["p", target.pubkey],
        ["k", String(target.kind)],
        ["h", groupId],
      ];
      // NIP-30 custom emoji: content is `:shortcode:`, emoji tag carries the url.
      if (emojiUrl && content.startsWith(":") && content.endsWith(":")) {
        tags.push(["emoji", content.slice(1, -1), emojiUrl]);
      }
      await createEvent({ kind: KIND_REACTION, content, tags, relay: relayUrl });
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey });
    },
  });

  return {
    tallies,
    isLoading: reactionsQuery.isLoading,
    react: (input: ReactInput) => react.mutate(input),
    isReacting: react.isPending,
  };
}
