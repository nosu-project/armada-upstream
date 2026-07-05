import { useMemo, useRef } from "react";

import {
  useChannelTimeline2,
  useMessageActions2,
  useSendMessage2,
  useSendStatus2,
} from "@/concord-v2/hooks/useChannel2";
import { useCurrentUser } from "@/hooks/useCurrentUser";
import { customEmojiReactionTags } from "@/hooks/useReactions";
import { KIND_REACTION } from "@/concord-v2/lib/kinds";
import type { OpenedChat } from "@/concord-v2/lib/chat";
import type { ChannelV2, CommunityV2 } from "@/concord-v2/lib/types";

import { toChatMsg } from "@/components/chat/transport";
import type { ChatMsg, ChatTransport, MessageReactions, ReactInput, ReactionTally } from "@/components/chat/transport";

/** Shared empty tally array, so messages with no reactions keep a stable prop. */
const EMPTY_TALLIES: ReactionTally[] = [];

/** Adapt a decrypted V2 chat event to the shared `ChatMsg` shape. */
export function openedToChatMsg(m: OpenedChat): ChatMsg {
  return toChatMsg({
    id: m.rumorId,
    pubkey: m.author,
    created_at: Math.floor(m.ms / 1000),
    kind: m.kind,
    tags: m.tags,
    content: m.content,
  });
}

/**
 * Build a {@link ChatTransport} for one Concord V2 channel — V2's binding to
 * the SAME chat components NIP-29, DMs, and Concord V1 render through. Only
 * the transport (CORD-01 streams vs relay kind-9 vs V1 `#z` envelopes)
 * differs.
 */
export function useTransport2(
  community: CommunityV2 | undefined,
  channel: ChannelV2 | undefined,
  canWrite: boolean,
  canModerate: boolean,
): {
  transport: ChatTransport;
  reactionsFor: (id: string) => MessageReactions;
  /** The full decoded message list (member enumeration, reply resolution). */
  allMessages: ChatMsg[];
} {
  const { user } = useCurrentUser();
  const { folded, isLoading, loadOlder, hasMore, isLoadingOlder } = useChannelTimeline2(community, channel);
  const { mutateAsync: send } = useSendMessage2(community, channel);
  const { retry, discard, deleteMessage } = useMessageActions2(community, channel);
  const sendStatus = useSendStatus2(channel);

  // Identity-cached ChatMsg adaptation (unchanged rows keep their reference so
  // React.memo skips them across polls).
  const adaptCache = useRef(new Map<string, { sig: string; msg: ChatMsg }>());
  const messages = useMemo<ChatMsg[]>(() => {
    const cache = adaptCache.current;
    const next = new Map<string, { sig: string; msg: ChatMsg }>();
    const out = folded.messages.map((m) => {
      const sig = `${m.kind}\u0000${m.ms}\u0000${m.content}`;
      const hit = cache.get(m.rumorId);
      const entry = hit && hit.sig === sig ? hit : { sig, msg: openedToChatMsg(m) };
      next.set(m.rumorId, entry);
      return entry.msg;
    });
    adaptCache.current = next;
    return out;
  }, [folded.messages]);

  // Reaction tallies adapted to the shared shape.
  const talliesById = useMemo(() => {
    const out = new Map<string, ReactionTally[]>();
    for (const [targetId, byEmoji] of folded.reactions) {
      const tallies: ReactionTally[] = [];
      for (const [emoji, entry] of byEmoji) {
        tallies.push({
          key: emoji,
          url: entry.url,
          count: entry.reactors.size,
          pubkeys: [...entry.reactors],
          mine: Boolean(user && entry.reactors.has(user.pubkey)),
        });
      }
      tallies.sort((a, b) => b.count - a.count);
      out.set(targetId, tallies);
    }
    return out;
  }, [folded.reactions, user]);

  const reactionsFor = useMemo(() => {
    const reactCache = new Map<string, (input: ReactInput) => void>();
    const reactFor = (id: string) => {
      let fn = reactCache.get(id);
      if (!fn) {
        fn = (input: ReactInput) => {
          void send({
            content: input.content,
            kind: KIND_REACTION,
            target: id,
            extraTags: customEmojiReactionTags(input.content, input.emojiUrl),
          }).catch(() => {});
        };
        reactCache.set(id, fn);
      }
      return fn;
    };
    const objCache = new Map<string, { tallies: ReactionTally[]; value: MessageReactions }>();
    return (id: string): MessageReactions => {
      const tallies = talliesById.get(id) ?? EMPTY_TALLIES;
      const hit = objCache.get(id);
      if (hit && hit.tallies === tallies) return hit.value;
      const value: MessageReactions = { tallies, react: reactFor(id) };
      objCache.set(id, { tallies, value });
      return value;
    };
  }, [talliesById, send]);

  const transport = useMemo<ChatTransport>(
    () => ({
      messages,
      isLoading,
      canWrite,
      canModerate,
      loadOlder,
      hasMore,
      isLoadingOlder,
      sendStatusFor: (id: string) => sendStatus[id],
      retry: (event: ChatMsg) => retry(event.id),
      discard,
      deleteMessage: (event: ChatMsg) => deleteMessage(event.id),
    }),
    [messages, isLoading, canWrite, canModerate, loadOlder, hasMore, isLoadingOlder, sendStatus, retry, discard, deleteMessage],
  );

  return { transport, reactionsFor, allMessages: messages };
}
