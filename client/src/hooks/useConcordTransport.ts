import { useMemo, useRef } from "react";

import {
  useConcordChannelMessages,
  useConcordReactions,
  useConcordSendStatus,
  useRetryConcordMessage,
  useSendConcordMessage,
} from "@/hooks/useConcordChannel";
import { useCurrentUser } from "@/hooks/useCurrentUser";
import { KIND_COMMUNITY_REACTION } from "@/lib/concord/kinds";

import type { OpenedMessage } from "@/lib/concord/envelope";
import type { Channel, Community } from "@/lib/concord/types";
import type { ChatMsg, ChatTransport, MessageReactions, ReactInput, ReactionTally } from "@/components/chat/transport";
import type { NostrEvent } from "@nostrify/nostrify";

/** Shared empty tally array, so messages with no reactions keep a stable prop. */
const EMPTY_TALLIES: ReactionTally[] = [];

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
          // NIP-30 custom emoji: content is `:shortcode:` and the image URL rides
          // along on an `emoji` inner tag so the reaction pill renders the image
          // (matching NIP-29). Native/unicode reactions carry no extra tag.
          const extraTags =
            input.emojiUrl && input.content.startsWith(":") && input.content.endsWith(":")
              ? [["emoji", input.content.slice(1, -1), input.emojiUrl]]
              : undefined;
          void send({
            content: input.content,
            kind: KIND_COMMUNITY_REACTION,
            reference: id,
            extraTags,
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
      messages,
      isLoading,
      canWrite,
      canModerate,
      sendStatusFor: (id: string) => sendStatus[id],
      retry: (event: ChatMsg) => retry(event.id),
      discard,
      deleteMessage: (event: NostrEvent) => deleteMessage(event.id),
    }),
    [messages, isLoading, canWrite, canModerate, sendStatus, retry, discard, deleteMessage],
  );

  return { transport, reactionsFor };
}
