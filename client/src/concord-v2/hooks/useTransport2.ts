import { useCallback, useMemo, useRef } from "react";

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

/** Shared empty reply array, so a thread with no replies keeps a stable reference. */
const EMPTY_REPLIES: ChatMsg[] = [];

/** The root id a message replies to (NIP-C7 `q` tag), if any. */
function replyRootOf(m: ChatMsg): string | undefined {
  return m.tags.find((t) => t[0] === "q")?.[1];
}

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

  // Threading: a reply is an ordinary sealed chat message carrying a
  // `["q", root, "", author]` tag (NIP-C7). Slack-style, replies are NOT shown
  // top-level — they're nested under their root in the thread panel. Split the
  // decoded list into top-level messages (the timeline) and replies bucketed by
  // root id (the threads).
  //
  // ORPHANS render top-level: a reply whose root is not in the loaded window
  // (older history, or a root this client never decoded) would otherwise be
  // bucketed under a row that never renders — decoded, in memory, and
  // completely unreachable (issue #19: "notified but never rendered"). It
  // degrades to an ordinary timeline row until the root loads, at which point
  // it folds back into the thread.
  const { topLevel, repliesByRoot } = useMemo(() => {
    const topLevel: ChatMsg[] = [];
    const repliesByRoot = new Map<string, ChatMsg[]>();
    const loaded = new Set(messages.map((m) => m.id));
    for (const m of messages) {
      const root = replyRootOf(m);
      if (root && loaded.has(root)) {
        const list = repliesByRoot.get(root) ?? [];
        list.push(m);
        repliesByRoot.set(root, list);
      } else {
        topLevel.push(m);
      }
    }
    for (const list of repliesByRoot.values()) list.sort((a, b) => a.created_at - b.created_at);
    return { topLevel, repliesByRoot };
  }, [messages]);

  const replyCountFor = useCallback((id: string) => repliesByRoot.get(id)?.length ?? 0, [repliesByRoot]);
  const threadRepliesFor = useCallback(
    (rootId: string): ChatMsg[] => repliesByRoot.get(rootId) ?? EMPTY_REPLIES,
    [repliesByRoot],
  );
  const sendThreadReply = useCallback(
    async (root: ChatMsg, content: string, tags: string[][]) => {
      // Seal the reply as a normal chat message; drop the composer's NIP-29 `h`
      // and any `e`/`q` tags (the reply target rides the rumor's own `q`),
      // mirroring the page's `handleSend`.
      const extraTags = tags.filter(([name]) => name !== "h" && name !== "e" && name !== "q");
      await send({ content, replyTo: { id: root.id, author: root.pubkey }, extraTags });
    },
    [send],
  );

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
      messages: topLevel,
      isLoading,
      canWrite,
      canModerate,
      isRumor: true,
      loadOlder,
      hasMore,
      isLoadingOlder,
      sendStatusFor: (id: string) => sendStatus[id],
      retry: (event: ChatMsg) => retry(event.id),
      discard,
      deleteMessage: (event: ChatMsg) => deleteMessage(event.id),
      replyCountFor,
      reactionsFor,
      threadRepliesFor,
      sendThreadReply,
    }),
    [topLevel, isLoading, canWrite, canModerate, loadOlder, hasMore, isLoadingOlder, sendStatus, retry, discard, deleteMessage, replyCountFor, reactionsFor, threadRepliesFor, sendThreadReply],
  );

  return { transport, reactionsFor, allMessages: messages };
}
