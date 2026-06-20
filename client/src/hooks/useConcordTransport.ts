import { useMemo } from "react";

import {
  useConcordChannelMessages,
  useConcordReactions,
  useSendConcordMessage,
} from "@/hooks/useConcordChannel";
import { useCurrentUser } from "@/hooks/useCurrentUser";
import { KIND_COMMUNITY_DELETE, KIND_COMMUNITY_REACTION } from "@/lib/concord/kinds";

import type { OpenedMessage } from "@/lib/concord/envelope";
import type { Channel, Community } from "@/lib/concord/types";
import type { ChatMsg, ChatTransport, MessageReactions, ReactInput, ReactionTally } from "@/components/chat/transport";
import type { NostrEvent } from "@nostrify/nostrify";

/**
 * Adapt a decrypted Concord message to the shared `ChatMsg` (NostrEvent) shape
 * so it renders through the SAME `MessageRow`/`ChatContent`/`ChatMessage` path
 * as NIP-29 group chat and DMs — author profile, rich content, emoji, media,
 * mentions, replies. The inner event's id/author/tags/content are authentic
 * (verified on open); the sig is omitted (rendering never re-verifies it).
 */
export function openedToEvent(m: OpenedMessage): ChatMsg {
  return {
    id: m.messageId,
    pubkey: m.author,
    created_at: Math.floor(m.ms / 1000),
    kind: m.kind,
    tags: m.tags,
    content: m.content,
    sig: "",
  };
}

/**
 * Build a {@link ChatTransport} for one Concord channel from the channel's
 * sealed-envelope hooks. This is Concord's binding to the shared chat UI: it
 * supplies messages (decrypted + adapted), reactions, sending and cooperative
 * self-delete. Capabilities Concord doesn't have yet (pins, threads, in-channel
 * search, optimistic send-status, history backfill) are simply omitted, so the
 * shared components hide those controls automatically.
 */
export function useConcordTransport(
  community: Community | undefined,
  channel: Channel | undefined,
  canWrite: boolean,
  canModerate: boolean,
): { transport: ChatTransport; reactionsFor: (id: string) => MessageReactions } {
  const { user } = useCurrentUser();
  const { data: opened, isLoading } = useConcordChannelMessages(community, channel);
  const { data: rawReactions } = useConcordReactions(community, channel);
  const { mutateAsync: send } = useSendConcordMessage(community, channel);

  const messages = useMemo<ChatMsg[]>(() => (opened ?? []).map(openedToEvent), [opened]);

  // Adapt Concord's per-channel tally (target id → emoji → reactor set) into the
  // shared `ReactionTally[]` shape per message, so `ReactionBar`/`ReactionPicker`
  // render identically to NIP-29.
  const talliesById = useMemo(() => {
    const out = new Map<string, ReactionTally[]>();
    if (!rawReactions) return out;
    for (const [targetId, byEmoji] of rawReactions) {
      const tallies: ReactionTally[] = [];
      for (const [emoji, reactors] of byEmoji) {
        tallies.push({
          key: emoji,
          count: reactors.size,
          pubkeys: [...reactors],
          mine: Boolean(user && reactors.has(user.pubkey)),
        });
      }
      tallies.sort((a, b) => b.count - a.count);
      out.set(targetId, tallies);
    }
    return out;
  }, [rawReactions, user]);

  const reactionsFor = useMemo(() => {
    return (id: string): MessageReactions => ({
      tallies: talliesById.get(id) ?? [],
      react: (input: ReactInput) => {
        // Concord reactions carry the emoji as content; a `:shortcode:` reacts
        // with its literal form (no custom-emoji image plumbing yet).
        void send({ content: input.content, kind: KIND_COMMUNITY_REACTION, reference: id }).catch(() => {});
      },
    });
  }, [talliesById, send]);

  const transport = useMemo<ChatTransport>(
    () => ({
      messages,
      isLoading,
      canWrite,
      canModerate,
      deleteMessage: (event: NostrEvent) => {
        // Cooperative self-delete: a sealed 3305 referencing the message. The
        // read path drops a message whose own author published a delete for it.
        void send({ content: "", kind: KIND_COMMUNITY_DELETE, reference: event.id }).catch(() => {});
      },
    }),
    [messages, isLoading, canWrite, canModerate, send],
  );

  return { transport, reactionsFor };
}
