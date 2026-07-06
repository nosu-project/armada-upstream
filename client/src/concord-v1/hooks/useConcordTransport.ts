import { useCallback, useMemo, useRef } from "react";

import {
  useConcordChannelMessages,
  useConcordReactions,
  useConcordSendStatus,
  useRetryConcordMessage,
  useSendConcordMessage,
} from "@/concord-v1/hooks/useConcordChannel";
import { useCurrentUser } from "@/hooks/useCurrentUser";
import { customEmojiReactionTags } from "@/hooks/useReactions";
import { KIND_COMMUNITY_REACTION } from "@/concord-v1/lib/kinds";

import type { OpenedMessage } from "@/concord-v1/lib/envelope";
import type { Channel, Community } from "@/concord-v1/lib/types";
import { toChatMsg } from "@/components/chat/transport";
import type { ChatMsg, ChatTransport, MessageReactions, ReactInput, ReactionTally } from "@/components/chat/transport";
import type { NostrEvent } from "@nostrify/nostrify";

/** Shared empty tally array, so messages with no reactions keep a stable prop. */
const EMPTY_TALLIES: ReactionTally[] = [];

/** Shared empty reply array, so a thread with no replies keeps a stable reference. */
const EMPTY_REPLIES: ChatMsg[] = [];

/** The root id a message replies to (NIP-10 marked `reply`/`root` `e` tag), if any. */
function replyRootOf(m: ChatMsg): string | undefined {
  const reply = m.tags.find(([name, , , marker]) => name === "e" && marker === "reply");
  if (reply) return reply[1];
  const root = m.tags.find(([name, , , marker]) => name === "e" && marker === "root");
  return root?.[1];
}

/**
 * Adapt a decrypted Concord message to the shared `ChatMsg` (NostrEvent) shape
 * so it renders through the SAME `MessageRow`/`ChatContent`/`ChatMessage` path
 * as NIP-29 group chat and DMs — author profile, rich content, emoji, media,
 * mentions, replies. The inner event's id/author/tags/content are authentic
 * (verified on open); the sig is omitted (rendering never re-verifies it).
 */
export function openedToEvent(m: OpenedMessage): ChatMsg {
  return toChatMsg({
    id: m.messageId,
    pubkey: m.author,
    created_at: Math.floor(m.ms / 1000),
    kind: m.kind,
    tags: m.tags,
    content: m.content,
  });
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
): {
  transport: ChatTransport;
  reactionsFor: (id: string) => MessageReactions;
  /**
   * The FULL decoded message list (not the render window). Used for things that
   * must see all history — member enumeration, reply-target author resolution —
   * so they stay correct regardless of how far the timeline has scrolled back.
   */
  allMessages: ChatMsg[];
} {
  const { user } = useCurrentUser();
  const { data: opened, isLoading, loadOlder, hasMore, isLoadingOlder } = useConcordChannelMessages(
    community,
    channel,
  );
  const { data: rawReactions } = useConcordReactions(community, channel);
  const { mutateAsync: send } = useSendConcordMessage(community, channel);
  const { retry, discard, deleteMessage } = useRetryConcordMessage(community, channel);
  const sendStatus = useConcordSendStatus(channel);

  // Adapt opened messages to the shared `ChatMsg` shape, preserving object
  // identity for unchanged messages across polls. `useConcordChannelMessages`
  // returns a fresh array (with freshly-decoded objects for any message the
  // network re-surfaced) every 15s; without identity caching, every `ChatMsg`
  // would change reference each poll, defeating `React.memo` on the rows and
  // forcing the whole timeline (regex tokenization, emoji maps, author queries)
  // to re-render on every poll. Key the cache on id + a content/tag signature so
  // a row is rebuilt only when its actual content changes (e.g. an edit).
  const adaptCache = useRef(new Map<string, { sig: string; msg: ChatMsg }>());
  const messages = useMemo<ChatMsg[]>(() => {
    const cache = adaptCache.current;
    const next = new Map<string, { sig: string; msg: ChatMsg }>();
    const out = (opened ?? []).map((m) => {
      const sig = `${m.kind}\u0000${m.ms}\u0000${m.content}\u0000${JSON.stringify(m.tags)}`;
      const hit = cache.get(m.messageId);
      const entry = hit && hit.sig === sig ? hit : { sig, msg: openedToEvent(m) };
      next.set(m.messageId, entry);
      return entry.msg;
    });
    adaptCache.current = next;
    return out;
  }, [opened]);

  // Threading: a reply is an ordinary sealed chat message carrying a
  // `["e", root, "", "reply"]` tag (see envelope.ts). Slack-style, replies are
  // NOT shown top-level — they're nested under their root in the thread panel.
  // Split the decoded list into top-level messages (the timeline) and replies
  // bucketed by root id (the threads).
  const { topLevel, repliesByRoot } = useMemo(() => {
    const topLevel: ChatMsg[] = [];
    const repliesByRoot = new Map<string, ChatMsg[]>();
    for (const m of messages) {
      const root = replyRootOf(m);
      if (root) {
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
      // Seal the reply as a normal chat message with the root as its `e`
      // reference; drop the composer's NIP-29 `h` and its own NIP-10 `e` tags
      // (the reply target is carried by `reference`), mirroring `handleSend`.
      const extraTags = tags.filter(([name]) => name !== "h" && name !== "e");
      await send({ content, reference: root.id, extraTags });
    },
    [send],
  );


  // Adapt Concord's per-channel tally (target id → emoji → reactor set) into the
  // shared `ReactionTally[]` shape per message, so `ReactionBar`/`ReactionPicker`
  // render identically to NIP-29.
  const talliesById = useMemo(() => {
    const out = new Map<string, ReactionTally[]>();
    if (!rawReactions) return out;
    for (const [targetId, byEmoji] of rawReactions) {
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
  }, [rawReactions, user]);

  const reactionsFor = useMemo(() => {
    // Stable `react` closure per id, so re-tallies don't churn the callback.
    const reactCache = new Map<string, (input: ReactInput) => void>();
    const reactFor = (id: string) => {
      let fn = reactCache.get(id);
      if (!fn) {
        fn = (input: ReactInput) => {
          void send({
            content: input.content,
            kind: KIND_COMMUNITY_REACTION,
            reference: id,
            extraTags: customEmojiReactionTags(input.content, input.emojiUrl),
          }).catch(() => {});
        };
        reactCache.set(id, fn);
      }
      return fn;
    };
    // Cache the `MessageReactions` object per id, keyed on the tallies reference,
    // so a message whose tally didn't change keeps a STABLE `reactions` prop —
    // otherwise a single new reaction anywhere would hand every row a fresh
    // object and re-render the whole timeline.
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
      loadOlder,
      hasMore,
      isLoadingOlder,
      sendStatusFor: (id: string) => sendStatus[id],
      retry: (event: ChatMsg) => retry(event.id),
      discard,
      deleteMessage: (event: NostrEvent) => deleteMessage(event.id),
      replyCountFor,
      reactionsFor,
      threadRepliesFor,
      sendThreadReply,
    }),
    [topLevel, isLoading, canWrite, canModerate, loadOlder, hasMore, isLoadingOlder, sendStatus, retry, discard, deleteMessage, replyCountFor, reactionsFor, threadRepliesFor, sendThreadReply],
  );

  return { transport, reactionsFor, allMessages: messages };
}
