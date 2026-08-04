import { useCallback, useMemo, useRef } from "react";
import { useQueryClient } from "@tanstack/react-query";

import {
  useChannelTimeline2,
  useMessageActions2,
  useSendMessage2,
  useSendStatus2,
} from "@/concord-v2/hooks/useChannel2";
import { useCurrentUser } from "@/hooks/useCurrentUser";
import { customEmojiReactionTags } from "@/hooks/useReactions";
import { KIND_CALENDAR_RSVP, KIND_COMMENT, KIND_DELETE, KIND_EDIT, KIND_ONCHAIN_ZAP, KIND_POLL, KIND_POLL_VOTE, KIND_REACTION, KIND_ZAP } from "@/concord-v2/lib/kinds";
import { markReactionDeleted, type OpenedChat } from "@/concord-v2/lib/chat";
import { timerNoticeSeconds } from "@/concord-v2/lib/disappearing";
import { channelKey } from "@/concord-v2/hooks/useChannel2";
import type { DmTimerTimelineEntry } from "@/components/chat/channelTimeline";
import { buildCalendarTags, type CalendarEvent, type CalendarEventInput, type CalendarTransport, parseCalendarEvents, type RsvpStatus, type RsvpTally, tallyRsvps } from "@/lib/calendar";
import { buildPollTags, parsePoll, tallyPollVotes, type PollTally, type PollVote } from "@/lib/polls";
import { zapRumorTags, type ZapTally } from "@/lib/zaps";
import type { ChannelV2, CommunityV2 } from "@/concord-v2/lib/types";

import { stableZapsFor, toChatMsg } from "@/components/chat/transport";
import type { ChatMsg, ChatTransport, MessageCalendar, MessagePoll, MessageReactions, OnchainZapAnnouncement, PollDraft, ReactInput, ReactionTally, ZapPayment } from "@/components/chat/transport";

/** Shared empty tally array, so messages with no reactions keep a stable prop. */
const EMPTY_TALLIES: ReactionTally[] = [];

/** Shared empty reply array, so a thread with no replies keeps a stable reference. */
const EMPTY_REPLIES: ChatMsg[] = [];

/** Shared empty vote array, so a poll with no votes keeps a stable reference. */
const EMPTY_VOTES: PollVote[] = [];

/**
 * The thread-root rumor id a message belongs to, or undefined for a top-level
 * message. Threaded replies are NIP-22 kind-1111 comments carrying an uppercase
 * `E` root tag. A kind-9 `q` tag is an INLINE reply (rendered in the timeline,
 * not a thread), so it is NOT a thread root here.
 */
function replyRootOf(m: ChatMsg): string | undefined {
  return m.kind === KIND_COMMENT ? m.tags.find((t) => t[0] === "E")?.[1] : undefined;
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
  /** The route's channel id, for the pre-fold snapshot seed (see useChannelTimeline2). */
  routeChannelIdHex?: string | null,
): {
  transport: ChatTransport;
  reactionsFor: (id: string) => MessageReactions;
  /** The full decoded message list (member enumeration, reply resolution). */
  allMessages: ChatMsg[];
  /** The channel's calendar events + RSVPs, for the shared events bar. */
  calendar: CalendarTransport;
  /**
   * Disappearing-messages timer notices (CORD-08 §4) as ready-made timeline
   * entries — the same centered-notice shape the DM feed renders. The page
   * merges them into its `entries` via {@link mergeChannelTimeline}.
   */
  timerEntries: DmTimerTimelineEntry[];
} {
  const { user } = useCurrentUser();
  const queryClient = useQueryClient();
  const { folded, isLoading, loadOlder, hasMore, isLoadingOlder } = useChannelTimeline2(community, channel, routeChannelIdHex);
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

  // Threading: a THREAD reply is a sealed NIP-22 kind-1111 comment carrying an
  // uppercase `E` thread-root tag. Slack-style, thread replies are NOT shown
  // top-level — they're nested under their root in the thread panel. An INLINE
  // reply (kind-9 with a `q` tag) is NOT a thread reply: it renders as an
  // ordinary timeline row with a "replying to …" line, so it's never bucketed
  // here. Split the decoded list into top-level messages (the timeline) and
  // thread replies bucketed by root id (the threads).
  //
  // ORPHAN replies (root not in the loaded window) are kept in repliesByRoot,
  // NOT degraded to top-level. They're reachable from the Threads tab, which
  // shows a tombstone for the missing root. When the root eventually loads
  // (backfill / decode), the reply stays bucketed under it and the tombstone
  // is replaced by the real root message.
  const replyBucketCache = useRef(new Map<string, ChatMsg[]>());
  const { topLevel, repliesByRoot } = useMemo(() => {
    const topLevel: ChatMsg[] = [];
    const buckets = new Map<string, ChatMsg[]>();
    for (const m of messages) {
      const root = replyRootOf(m);
      if (root) {
        const list = buckets.get(root) ?? [];
        list.push(m);
        buckets.set(root, list);
      } else {
        topLevel.push(m);
      }
    }
    // A bucket whose contents didn't change keeps its previous array identity:
    // these go straight to memoized rows as the `replies` prop, and a fresh
    // array per fold re-rendered every row that has a thread on every arriving
    // message. Element-wise compare is sound because `messages` entries are
    // themselves identity-cached above.
    const cache = replyBucketCache.current;
    const repliesByRoot = new Map<string, ChatMsg[]>();
    for (const [root, list] of buckets) {
      list.sort((a, b) => a.created_at - b.created_at);
      const prev = cache.get(root);
      const unchanged = prev && prev.length === list.length && prev.every((m, i) => m === list[i]);
      repliesByRoot.set(root, unchanged ? prev : list);
    }
    replyBucketCache.current = repliesByRoot;
    return { topLevel, repliesByRoot };
  }, [messages]);

  const replyCountFor = useCallback((id: string) => repliesByRoot.get(id)?.length ?? 0, [repliesByRoot]);
  const threadRepliesFor = useCallback(
    (rootId: string): ChatMsg[] => repliesByRoot.get(rootId) ?? EMPTY_REPLIES,
    [repliesByRoot],
  );
  const sendThreadReply = useCallback(
    async (root: ChatMsg, content: string, tags: string[][]) => {
      // Seal the reply as a NIP-22 kind-1111 comment; the thread pointers are
      // derived from `root` inside `send` (via `replyTo`). Drop the composer's
      // NIP-29 `h` and any `e`/`q` tags (a `q` here would be an inline quote, not
      // the thread link), mirroring the page's `handleSend`.
      const extraTags = tags.filter(([name]) => name !== "h" && name !== "e" && name !== "q");
      await send({
        content,
        replyTo: { id: root.id, kind: root.kind, pubkey: root.pubkey, tags: root.tags },
        extraTags,
      });
    },
    [send],
  );

  // Reaction tallies adapted to the shared shape.
  const talliesById = useMemo(() => {
    const out = new Map<string, ReactionTally[]>();
    for (const [targetId, byEmoji] of folded.reactions) {
      const tallies: ReactionTally[] = [];
      for (const [emoji, entry] of byEmoji) {
        const mine = Boolean(user && entry.reactors.has(user.pubkey));
        tallies.push({
          key: emoji,
          url: entry.url,
          count: entry.reactors.size,
          pubkeys: [...entry.reactors.keys()],
          mine,
          mineEventId: mine ? entry.reactors.get(user!.pubkey) : undefined,
        });
      }
      tallies.sort((a, b) => b.count - a.count);
      out.set(targetId, tallies);
    }
    return out;
  }, [folded.reactions, user]);

  const channelIdHex = channel?.idHex ?? null;

  // Author lookup by rumor id, so a reaction can carry a NIP-25 `p` tag for the
  // reacted-to author (mirroring the NIP-29 path). Invisible to the relay: the
  // tag lives on the NIP-44-encrypted rumor, never promoted to the wrap.
  const authorById = useMemo(() => {
    const out = new Map<string, string>();
    for (const m of messages) out.set(m.id, m.pubkey);
    return out;
  }, [messages]);

  const reactionsFor = useMemo(() => {
    const reactCache = new Map<string, (input: ReactInput) => void>();
    const reactFor = (id: string) => {
      let fn = reactCache.get(id);
      if (!fn) {
        fn = (input: ReactInput) => {
          if (input.mineEventId) {
            // Removing: mark the reaction as deleted IMMEDIATELY so the fold
            // skips it on the next render (before the kind-5 delete rumor is
            // even sealed). Also strip it from the query cache so the fold
            // doesn't see it at all.
            markReactionDeleted(input.mineEventId);
            queryClient.setQueryData<OpenedChat[]>(channelKey(channelIdHex), (old = []) =>
              old.filter((m) => m.rumorId !== input.mineEventId),
            );
            // Seal + publish the kind-5 delete rumor (the store's NIP-09
            // removes it durably; the mark above handles the optimistic case).
            void send({
              content: "",
              kind: KIND_DELETE,
              target: input.mineEventId,
              targetKind: KIND_REACTION,
            }).catch(() => {});
          } else {
            void send({
              content: input.content,
              kind: KIND_REACTION,
              target: id,
              targetPubkey: authorById.get(id),
              extraTags: customEmojiReactionTags(input.content, input.emojiUrl),
            }).catch(() => {});
          }
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
  }, [talliesById, send, queryClient, channelIdHex, authorById]);

  // CORD.md zap tallies from the fold (only VERIFIED zaps ever reach it).
  const zapTalliesById = useMemo(() => {
    const out = new Map<string, ZapTally>();
    for (const [targetId, entries] of folded.zaps) {
      if (entries.length === 0) continue;
      const zaps = [...entries].sort((a, b) => b.sats - a.sats);
      out.set(targetId, {
        totalSats: zaps.reduce((sum, z) => sum + z.sats, 0),
        count: zaps.length,
        mine: Boolean(user && zaps.some((z) => z.pubkey === user.pubkey)),
        zaps,
      });
    }
    return out;
  }, [folded.zaps, user]);

  const zapsFor = useMemo(() => stableZapsFor((id) => zapTalliesById.get(id)), [zapTalliesById]);

  // Seal the CORD.md zap announcement into the channel: a kind-9735 rumor
  // carrying the payment proof, published through the ordinary send path (the
  // `e` target rides `send`'s target param; binding tags are added there).
  const sendZap = useCallback(
    async (target: ChatMsg, payment: ZapPayment) => {
      if (!payment.preimage) throw new Error("A private zap needs its payment proof.");
      await send({
        content: payment.comment,
        kind: KIND_ZAP,
        target: target.id,
        extraTags: zapRumorTags({
          targetId: target.id,
          targetKind: target.kind,
          recipient: target.pubkey,
          amountMsats: payment.amountMsats,
          bolt11: payment.bolt11,
          preimage: payment.preimage,
          omitTarget: true, // send() adds the e target itself
        }),
      });
    },
    [send],
  );

  // Seal the on-chain Bitcoin zap attribution (kind 8333) into the channel as
  // a rumor — publishing it publicly would leak the target event id and
  // community context. The txid is on a public ledger already; the Nostr
  // attribution is the part that must stay private.
  const sendOnchainZap = useCallback(
    async (target: ChatMsg, announcement: OnchainZapAnnouncement) => {
      const isAddressable = target.kind >= 30000 && target.kind < 40000;
      const tags: string[][] = [
        ["i", `bitcoin:tx:${announcement.txid}`],
        ["p", target.pubkey],
        ["amount", String(announcement.amountSats)],
      ];
      if (isAddressable) {
        const dTag = target.tags.find(([n]) => n === "d")?.[1] ?? "";
        tags.push(["a", `${target.kind}:${target.pubkey}:${dTag}`]);
      }
      tags.push(["k", String(target.kind)]);
      tags.push(["alt", `Bitcoin zap: ${announcement.amountSats.toLocaleString()} sats`]);
      await send({
        content: announcement.comment,
        kind: KIND_ONCHAIN_ZAP,
        target: target.id,
        extraTags: tags,
      });
    },
    [send],
  );

  // Poll tallies from the fold: each poll message is tallied against its own
  // declared options + endsAt (the pure {@link tallyPollVotes}, shared with the
  // NIP-29 path), so every member folds the same result.
  const pollTalliesById = useMemo(() => {
    const out = new Map<string, PollTally>();
    for (const m of messages) {
      if (m.kind !== KIND_POLL) continue;
      const { options, endsAt } = parsePoll(m);
      const votes = folded.pollVotes.get(m.id) ?? EMPTY_VOTES;
      out.set(m.id, tallyPollVotes(votes, options, endsAt, user?.pubkey));
    }
    return out;
  }, [messages, folded.pollVotes, user]);

  // Seal a vote as a kind-1018 rumor `e`-tagging the poll (a side event, like a
  // reaction — invisible in the timeline, folded into the poll's tally). The
  // latest vote per pubkey wins, so re-voting just supersedes the prior one.
  const sendPollVote = useCallback(
    (pollId: string, optionIds: string[]) => {
      void send({
        content: "",
        kind: KIND_POLL_VOTE,
        target: pollId,
        extraTags: optionIds.map((id) => ["response", id]),
      }).catch(() => {});
    },
    [send],
  );

  const pollFor = useMemo(() => {
    const voteCache = new Map<string, (optionIds: string[]) => void>();
    const voteFor = (id: string) => {
      let fn = voteCache.get(id);
      if (!fn) voteCache.set(id, (fn = (optionIds) => sendPollVote(id, optionIds)));
      return fn;
    };
    const objCache = new Map<string, { tally: PollTally; value: MessagePoll }>();
    return (id: string): MessagePoll | undefined => {
      const tally = pollTalliesById.get(id);
      if (!tally) return undefined;
      const hit = objCache.get(id);
      if (hit && hit.tally === tally) return hit.value;
      const value: MessagePoll = { tally, vote: voteFor(id) };
      objCache.set(id, { tally, value });
      return value;
    };
  }, [pollTalliesById, sendPollVote]);

  // Seal a new poll as a kind-1068 timeline message. The option/type/endsAt tags
  // are built by the shared {@link buildPollTags}; the channel binding is added
  // by `send`. No `relay` routing tag (NIP-88) — votes ride the sealed plane.
  const sendPoll = useCallback(
    async (draft: PollDraft) => {
      const question = draft.question.trim();
      await send({
        content: question,
        kind: KIND_POLL,
        extraTags: buildPollTags(question, draft.options, draft.pollType, draft.durationDays),
      });
    },
    [send],
  );

  // Calendar events (CORD.md): folded calendar rumors adapted to the shared
  // NostrEvent shape and parsed/deduped by the same helper the NIP-29 path uses.
  const calendarEvents = useMemo(
    () => parseCalendarEvents(folded.calendarEvents.map(openedToChatMsg)),
    [folded.calendarEvents],
  );
  const rsvpsFor = useCallback(
    (event: CalendarEvent): RsvpTally => tallyRsvps(folded.rsvps.get(event.event.id) ?? [], user?.pubkey),
    [folded.rsvps, user?.pubkey],
  );
  // Seal a new calendar event (kind 31922/31923). Not a timeline message — the
  // binding is added by `send`; NIP-52 tags come from the shared builder.
  const saveCalendar = useCallback(
    async (input: CalendarEventInput) => {
      await send({ content: input.description ?? "", kind: input.kind, extraTags: buildCalendarTags(input) });
    },
    [send],
  );
  const removeCalendar = useCallback(
    async (event: CalendarEvent) => {
      await send({ content: "", kind: KIND_DELETE, target: event.event.id, targetKind: event.kind });
    },
    [send],
  );
  // Seal an RSVP (kind 31925) `e`-tagging the event's rumor id — a side event
  // folded into the event's tally, latest per pubkey winning.
  const setRsvp = useCallback(
    (event: CalendarEvent, status: RsvpStatus) => {
      void send({
        content: "",
        kind: KIND_CALENDAR_RSVP,
        target: event.event.id,
        extraTags: [["status", status], ["k", String(event.kind)], ["p", event.event.pubkey]],
      }).catch(() => {});
    },
    [send],
  );
  const calendar = useMemo<CalendarTransport>(
    () => ({
      events: calendarEvents,
      canModerate,
      canRsvp: canWrite,
      isSaving: false,
      isSettingRsvp: false,
      save: saveCalendar,
      remove: removeCalendar,
      rsvpsFor,
      setRsvp,
    }),
    [calendarEvents, canModerate, canWrite, saveCalendar, removeCalendar, rsvpsFor, setRsvp],
  );

  // Calendar events ALSO render inline in the timeline (an event card), in
  // addition to the events bar. Each deduped event's rumor is already a ChatMsg
  // (adapted before parsing); slot them into the timeline by announcement time.
  const calendarMsgs = useMemo<ChatMsg[]>(() => calendarEvents.map((c) => c.event as ChatMsg), [calendarEvents]);
  const timeline = useMemo<ChatMsg[]>(() => {
    if (calendarMsgs.length === 0) return topLevel;
    return [...topLevel, ...calendarMsgs].sort((a, b) =>
      a.created_at !== b.created_at ? a.created_at - b.created_at : a.id < b.id ? -1 : 1,
    );
  }, [topLevel, calendarMsgs]);

  // Key-rotation boundaries: the first timeline row of each epoch RUN gets a
  // divider above it, so a rekey is a visible line in the conversation and
  // everything above it reads as sealed under a previous key. Epochs come from
  // the fold (the coordinate whose key decrypted each message), not the
  // adapted ChatMsg, which deliberately doesn't carry them.
  const rotationDividerIds = useMemo<ReadonlySet<string> | undefined>(() => {
    const epochById = new Map<string, bigint>();
    for (const m of folded.messages) epochById.set(m.rumorId, m.epoch);
    for (const c of folded.calendarEvents) epochById.set(c.rumorId, c.epoch);
    let prev: bigint | undefined;
    let ids: Set<string> | undefined;
    for (const m of timeline) {
      const epoch = epochById.get(m.id);
      if (epoch === undefined) continue;
      if (prev !== undefined && epoch !== prev) (ids ??= new Set()).add(m.id);
      prev = epoch;
    }
    return ids;
  }, [timeline, folded.messages, folded.calendarEvents]);

  // Per-event RSVP binding for the inline card, mirroring `pollFor`. Recomputed
  // when the event set or RSVP fold changes; identity-stable in between so an
  // unchanged calendar row keeps its `calendar` prop (React.memo).
  const calendarMessages = useMemo(() => {
    const map = new Map<string, MessageCalendar>();
    for (const c of calendarEvents) {
      map.set(c.event.id, {
        event: c,
        tally: rsvpsFor(c),
        canRsvp: canWrite,
        isSettingRsvp: false,
        setRsvp: (status) => setRsvp(c, status),
      });
    }
    return map;
  }, [calendarEvents, rsvpsFor, canWrite, setRsvp]);
  const calendarFor = useCallback((id: string) => calendarMessages.get(id), [calendarMessages]);

  // Concord edit: a kind-3302 rumor targeting the original message's rumor
  // id. The fold applies the latest author-matching edit (non-destructive —
  // the original keeps its id, so reactions, replies, and quotes stay intact).
  const editMessage = useCallback(
    async (original: ChatMsg, content: string) => {
      const trimmed = content.trim();
      if (!trimmed || trimmed === original.content.trim()) return;
      await send({
        content: trimmed,
        kind: KIND_EDIT,
        target: original.id,
        targetKind: original.kind,
      });
    },
    [send],
  );

  // Timer-change notices (CORD-08 §4), already authority-gated by the fold,
  // adapted to the DM timer entry shape the shared timeline renders.
  const timerEntries = useMemo<DmTimerTimelineEntry[]>(
    () =>
      folded.timerNotices.map((n) => ({
        type: "dm-timer" as const,
        id: `dm-timer:${n.rumorId}`,
        createdAt: Math.floor(n.ms / 1000),
        author: n.author,
        seconds: timerNoticeSeconds(n) ?? 0,
      })),
    [folded.timerNotices],
  );

  // Adapters from the id-keyed hooks to the event-keyed ChatTransport shape.
  // Defined OUTSIDE the transport memo: inline in it they'd take a new identity
  // every time `messages` changed, and they're handed straight to memoized
  // message rows as props — which would re-render the whole mounted window on
  // every arriving message and every backfilled page.
  const sendStatusFor = useCallback((id: string) => sendStatus[id], [sendStatus]);
  const retryEvent = useCallback((event: ChatMsg) => retry(event.id), [retry]);
  const deleteEvent = useCallback((event: ChatMsg) => deleteMessage(event.id), [deleteMessage]);

  const transport = useMemo<ChatTransport>(
    () => ({
      messages: timeline,
      isLoading,
      canWrite,
      canModerate,
      isRumor: true,
      rotationDividerIds,
      loadOlder,
      hasMore,
      isLoadingOlder,
      sendStatusFor,
      retry: retryEvent,
      discard,
      deleteMessage: deleteEvent,
      editMessage,
      replyCountFor,
      reactionsFor,
      zapsFor,
      sendZap,
      sendOnchainZap,
      pollFor,
      sendPoll,
      calendarFor,
      threadRepliesFor,
      sendThreadReply,
    }),
    [timeline, isLoading, canWrite, canModerate, rotationDividerIds, loadOlder, hasMore, isLoadingOlder, sendStatusFor, retryEvent, discard, deleteEvent, editMessage, replyCountFor, reactionsFor, zapsFor, sendZap, sendOnchainZap, pollFor, sendPoll, calendarFor, threadRepliesFor, sendThreadReply],
  );

  return { transport, reactionsFor, allMessages: messages, calendar, timerEntries };
}
