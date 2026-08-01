import { Hash, Loader2, Search } from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useSearchParams } from "react-router-dom";

import { ChatComposer } from "@/components/chat/ChatComposer";
import { ChatMessage, ReplyContextLine, ReplyPreview, ReplyThumbnail } from "@/components/chat/ChatMessage";
import { firstImageRef, getReplyToId } from "@/components/chat/messageHelpers";
import { MessageTimeline, type MessageTimelineHandle } from "@/components/chat/MessageTimeline";
import { ThreadPanel } from "@/components/chat/ThreadPanel";
import LoginDialog from "@/components/auth/LoginDialog";
import SignupDialog from "@/components/auth/SignupDialog";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { ComposerBoundsProvider } from "@/contexts/ComposerBoundsContext";
import { useAuthor } from "@/hooks/useAuthor";
import { useAppContext } from "@/hooks/useAppContext";
import { useCurrentUser } from "@/hooks/useCurrentUser";
import { useEvent } from "@/hooks/useEvent";
import { useGroup } from "@/hooks/useGroup";
import { useGroupMessages } from "@/hooks/useGroupMessages";
import { useGroupModeration } from "@/hooks/useGroupModeration";
import { useGroupSearch } from "@/hooks/useGroupSearch";
import { useDeleteOwnMessage, useEditMessage } from "@/hooks/useEditMessage";
import { usePinnedMessages } from "@/hooks/usePinnedMessages";
import { useGroupReactions } from "@/hooks/useReactions";
import { useZapReceipts } from "@/hooks/useZapReceipts";
import { useGroupThreads, useSendThreadReply } from "@/hooks/useThread";
import { useRepublish } from "@/hooks/useNostrPublish";
import { useActiveRoom } from "@/hooks/useActiveRoom";
import { useMessagePermalink } from "@/hooks/useMessagePermalink";
import { useNewMessagesDivider } from "@/hooks/useNewMessagesDivider";
import { channelReadKey, useReadState } from "@/hooks/useReadState";
import { toast } from "@/hooks/useToast";
import { useScopedDisplayName } from "@/hooks/useScopedDisplayName";
import { relayToRouteParam } from "@/lib/platform";
import { withSignature } from "@/lib/publishOutbox";
import { type SlashAction } from "@/lib/slashCommands";
import { cn } from "@/lib/utils";

import { threadSummary } from "@/components/chat/transport";
import type { ChatMsg, ChatTransport, MessageCalendar } from "@/components/chat/transport";
import type { CalendarTransport } from "@/lib/calendar";
import type { NostrEvent } from "@nostrify/nostrify";
import type { NostrRumor } from "@/lib/nostrRumor";

/** NIP-29 reply context: fetch the replied-to event from the relay, then render
 *  the shared chrome with the author name + a content preview. Clicking jumps
 *  the timeline to the replied-to message. */
function ReplyContext({ eventId, relayUrl, onJump }: { eventId: string; relayUrl: string; onJump: (id: string) => void }) {
  const { data: event } = useEvent(eventId, [relayUrl]);
  const author = useAuthor(event?.pubkey);
  const displayName = useScopedDisplayName(event?.pubkey, author.data?.metadata);

  if (!event) return null;

  const image = firstImageRef(event);
  return (
    <ReplyContextLine
      name={displayName}
      pubkey={event.pubkey}
      preview={<ReplyPreview content={event.content} hideMediaPlaceholder={!!image} />}
      thumbnail={image ? <ReplyThumbnail image={image} /> : undefined}
      onClick={() => onJump(eventId)}
    />
  );
}

interface Nip29ChatMessageProps {
  event: ChatMsg;
  relayUrl: string;
  groupId: string;
  transport: ChatTransport;
  isEditing: boolean;
  highlight?: string;
  active?: boolean;
  onToggleActive?: (id: string) => void;
  continuation: boolean;
  onEdit: (event: ChatMsg) => void;
  onEditSubmit: (event: ChatMsg, content: string) => void;
  onEditCancel: () => void;
  onJumpToReply: (id: string) => void;
  onReply: (event: ChatMsg) => void;
}

/**
 * NIP-29 binding for a single message. Reactions and threaded-reply counts are
 * resolved ONCE per room (batched) by {@link GroupChat} and read here from the
 * transport via `reactionsFor`/`replyCountFor` — no per-message relay hooks —
 * then rendered through the shared presentational {@link ChatMessage}.
 */
function Nip29ChatMessage({
  event,
  relayUrl,
  groupId,
  transport,
  isEditing,
  highlight,
  active,
  onToggleActive,
  continuation,
  onEdit,
  onEditSubmit,
  onEditCancel,
  onJumpToReply,
  onReply,
}: Nip29ChatMessageProps) {
  const { config } = useAppContext();
  // The transport object is rebuilt whenever `messages` changes — on every
  // arriving message and every backfilled page — so anything derived from it
  // inline hands ChatMessage a fresh prop identity and defeats its React.memo,
  // re-rendering the whole mounted window. The per-id accessors already return
  // identity-stable values; it's the inline arrows and object/element literals
  // that churn, so those are memoized here and the transport is read through a
  // ref so the callbacks don't have to depend on its identity.
  const transportRef = useRef(transport);
  transportRef.current = transport;

  const replies = transport.threadRepliesFor?.(event.id);
  const threadInfo = useMemo(() => threadSummary(replies ?? []), [replies]);
  const pollContext = useMemo(() => ({ relayUrl, groupId }), [relayUrl, groupId]);

  const handleRetry = useCallback(() => transportRef.current.retry?.(event), [event]);
  const handleDiscard = useCallback(() => transportRef.current.discard?.(event.id), [event]);

  const canOpenThread = Boolean(transport.openThread);
  const handleOpenThread = useMemo(
    () => (canOpenThread ? (e: ChatMsg) => transportRef.current.openThread!(e, true) : undefined),
    [canOpenThread],
  );

  const replyToId = getReplyToId(event);
  const replyContext = useMemo(
    () =>
      replyToId ? (
        <ReplyContext eventId={replyToId} relayUrl={relayUrl} onJump={onJumpToReply} />
      ) : undefined,
    [replyToId, relayUrl, onJumpToReply],
  );
  const permalink = useMemo(
    () => `/s/${relayToRouteParam(relayUrl)}/${encodeURIComponent(groupId)}`,
    [relayUrl, groupId],
  );

  return (
    <ChatMessage
      event={event}
      permalink={permalink}
      canWrite={transport.canWrite}
      canModerate={transport.canModerate}
      pollContext={pollContext}
      calendar={transport.calendarFor?.(event.id)}
      reactions={transport.reactionsFor?.(event.id)}
      zapEnabled={config.zapsEnabled && Boolean(transport.zapsFor)}
      zaps={transport.zapsFor?.(event.id)}
      onSendZap={transport.sendZap}
      onSendOnchainZap={transport.sendOnchainZap}
      sendStatus={transport.sendStatusFor?.(event.id)}
      highlight={highlight}
      isEditing={isEditing}
      isPinned={transport.isPinned?.(event.id)}
      replyCount={transport.replyCountFor?.(event.id) ?? 0}
      threadParticipants={threadInfo.participants}
      lastReplyAt={threadInfo.lastReplyAt}
      replyContext={replyContext}
      onRetry={handleRetry}
      onDiscard={handleDiscard}
      onTogglePin={transport.togglePin}
      onDelete={transport.deleteMessage}
      onOpenThread={handleOpenThread}
      onReply={onReply}
      onEdit={onEdit}
      onEditSubmit={onEditSubmit}
      onEditCancel={onEditCancel}
      active={active}
      onToggleActive={onToggleActive}
      continuation={continuation}
    />
  );
}

/**
 * A placeholder shaped exactly like {@link ChatComposer}'s input row, shown
 * while membership is still resolving so an actual member never sees the "join
 * to message" prompt flash — and so swapping to the real composer doesn't shift
 * the layout. Mirrors ChatComposer's outer wrapper, `p-2` body, and the
 * `clip-corner-lg bg-secondary/60` input pill (round + button, text line, round
 * action button).
 */
function ComposerSkeleton() {
  return (
    <div
      className="relative shrink-0 pb-[var(--safe-area-pad-bottom,0px)] sidebar:pb-[var(--safe-area-pad-bottom-tight,0.25rem)]"
      aria-hidden
    >
      <div className="p-2">
        <div className="flex items-end gap-0.5 clip-corner-lg bg-secondary/60 px-1.5 py-1.5">
          <Skeleton className="size-9 shrink-0 rounded-full" />
          <div className="flex-1 min-w-0 px-1.5 py-2">
            <Skeleton className="h-5 w-40 max-w-full rounded" />
          </div>
          <Skeleton className="size-9 shrink-0 rounded-full" />
        </div>
      </div>
    </div>
  );
}

interface GroupChatProps {
  relayUrl: string;
  groupId: string;
  /** Whether the current user can write to this group. */
  canWrite: boolean;
  /**
   * Whether membership is still resolving for a logged-in user (tri-state
   * "unknown"). While true, the composer area shows a skeleton instead of the
   * "join to message" prompt, so an actual member never sees the join prompt
   * flash before membership confirms.
   */
  membershipPending?: boolean;
  /** Whether the current user can moderate (delete messages). */
  canModerate: boolean;
  /**
   * The group's NIP-52 calendar events + RSVPs (assembled by GroupPage from the
   * relay hooks). Its events render inline in the timeline as event cards — the
   * same events the header's events bar lists.
   */
  calendar?: CalendarTransport;
  /**
   * Active search query. When non-empty, the timeline is replaced by matching
   * messages (filtered in-place in the chat area, not a separate view).
   */
  searchQuery?: string;
  /**
   * Populated by GroupChat with a function that scrolls a message into view by
   * id (used by the header's pinned-messages popover).
   */
  scrollToMessageRef?: React.MutableRefObject<((id: string) => void) | null>;
}

/**
 * The message timeline + composer for a NIP-29 group. Messages are kind 9
 * (and kind 1068 polls) with the `h` tag, published only to the group's host
 * relay. NIP-29 data + mutations are assembled here into a {@link ChatTransport}
 * and rendered through the shared {@link MessageTimeline}/{@link ChatMessage}/
 * {@link ChatComposer}, the same components Concord uses.
 */
export function GroupChat({ relayUrl, groupId, canWrite, membershipPending = false, canModerate, calendar, searchQuery = "", scrollToMessageRef }: GroupChatProps) {
  const { user } = useCurrentUser();
  const composerBoundsRef = useRef<HTMLElement | null>(null);
  const { data: groupDetails } = useGroup(relayUrl, groupId);
  const channelName = groupDetails?.group?.name;
  const {
    data: messages = [],
    isLoading,
    status: sendStatus,
    insertOptimistic,
    markSent,
    markFailed,
    removeOptimistic,
    loadOlder,
    hasMore,
    isLoadingOlder,
  } = useGroupMessages(relayUrl, groupId);
  const { deleteEvent, removeUser } = useGroupModeration(relayUrl, groupId);
  const { isPinned, pin, unpin } = usePinnedMessages(relayUrl, groupId);  const { mutateAsync: republish } = useRepublish();
  const { mutateAsync: editMessage } = useEditMessage(relayUrl, groupId);
  const { mutate: deleteOwnMessage } = useDeleteOwnMessage(relayUrl, groupId);
  const { markRead } = useReadState();
  // Where the red "NEW" divider sits for this visit (captured before markRead
  // stamps the channel below, frozen until the channel changes).
  const newDividerId = useNewMessagesDivider(
    channelReadKey(relayUrl, groupId),
    messages.map((message) => ({ id: message.id, createdAt: message.created_at, author: message.pubkey })),
    user?.pubkey,
  );
  const { results: searchResults, isLoading: searchLoading, active: searching } = useGroupSearch(
    relayUrl,
    groupId,
    searchQuery,
  );

  // Batched per-room reactions + reply counts: resolved ONCE for every message
  // currently in view (timeline ∪ search results), instead of one relay query +
  // live subscription per message. The rows read these back via the transport's
  // `reactionsFor`/`replyCountFor`. Mirrors Concord's `useConcordReactions`.
  const visibleIds = useMemo(() => {
    const set = new Set<string>();
    for (const m of messages) set.add(m.id);
    for (const m of searchResults) set.add(m.id);
    return [...set];
  }, [messages, searchResults]);
  const { replyCountFor, threadRepliesFor } = useGroupThreads(relayUrl, groupId, visibleIds);
  const sendThreadReply = useSendThreadReply(relayUrl, groupId);

  const [activeId, setActiveId] = useState<string | undefined>(undefined);
  const toggleActive = useCallback(
    (id: string) => setActiveId((cur) => (cur === id ? undefined : id)),
    [],
  );
  const [threadRoot, setThreadRoot] = useState<ChatMsg | undefined>(undefined);

  // Tell the native notification service this NIP-29 room (and, if a thread
  // panel is open, that specific thread) is on screen, so it suppresses
  // redundant tray entries. Cleared on unmount/background. The roomKey shapes
  // must match the service: `h:<relayUrl>|<groupId>` for the room,
  // `h:<relayUrl>|<groupId>:t:<rootId>` for a specific open thread.
  useActiveRoom(
    relayUrl && groupId ? `h:${relayUrl}|${groupId}` : undefined,
    relayUrl && groupId && threadRoot ? `h:${relayUrl}|${groupId}:t:${threadRoot.id}` : undefined,
  );

  // Auto-open the thread panel when arrived via a notification deep-link
  // (`?thread=<rootId>` — the service appends it for kind-1111 replies). Only
  // fires once per `thread` param: when the root message is in the loaded
  // window we open its thread; otherwise we clear the param so a later load
  // doesn't snap to it after the user has scrolled.
  const [searchParams, setSearchParams] = useSearchParams();
  const threadParam = searchParams.get("thread");
  useEffect(() => {
    if (!threadParam || threadRoot) return;
    const root = messages.find((m) => m.id === threadParam);
    if (root) {
      setThreadRoot(root);
      setSearchParams(
        (prev) => {
          const next = new URLSearchParams(prev);
          next.delete("thread");
          return next;
        },
        { replace: true },
      );
    }
  }, [threadParam, threadRoot, messages, setSearchParams]);

  // Reaction and zap tallies resolve over the timeline PLUS the open thread's
  // replies (kind-1111 comments, which aren't in the timeline), so a reply's
  // ⚡/emoji counts show in the thread panel too. The id set changes only when
  // a thread opens or closes.
  const tallyIds = useMemo(() => {
    if (!threadRoot) return visibleIds;
    const replyIds = (threadRepliesFor?.(threadRoot.id) ?? []).map((r) => r.id);
    if (replyIds.length === 0) return visibleIds;
    return [...new Set([...visibleIds, ...replyIds])];
  }, [visibleIds, threadRoot, threadRepliesFor]);

  const { reactionsFor } = useGroupReactions(relayUrl, groupId, tallyIds);
  // Public NIP-57 receipts for the visible window + open thread (providers
  // publish them to the app relays the 9734 lists).
  const { zapsFor } = useZapReceipts(
    relayUrl && groupId ? `nip29:${relayUrl}:${groupId}` : undefined,
    tallyIds,
  );
  const [threadAutoFocus, setThreadAutoFocus] = useState(false);
  const [threadExpanded, setThreadExpanded] = useState(false);
  const [lastThreadRoot, setLastThreadRoot] = useState<ChatMsg | undefined>(undefined);
  const [replyTo, setReplyTo] = useState<ChatMsg | undefined>(undefined);
  const [editingId, setEditingId] = useState<string | undefined>(undefined);
  const [joinDialogOpen, setJoinDialogOpen] = useState(false);
  const [signupDialogOpen, setSignupDialogOpen] = useState(false);
  const timelineRef = useRef<MessageTimelineHandle | null>(null);

  // Stable: clicking a reply-context line jumps the timeline to the original.
  const jumpToReply = useCallback((id: string) => {
    timelineRef.current?.scrollToMessage(id);
  }, []);

  // Message permalinks (`?m=<id>` — notification taps, copied links): scroll
  // to the target with the focus indicator once it's loaded, pulling older
  // pages when it's further back than the loaded history.
  const permalinkScroll = useCallback(
    (id: string) => timelineRef.current?.scrollToMessage(id, true) ?? false,
    [],
  );
  useMessagePermalink({
    messages,
    isLoading,
    hasMore,
    loadOlder,
    scrollTo: permalinkScroll,
    // While search results replace the timeline there is nothing to jump.
    enabled: !searching,
  });

  // Stable identities so an unchanged row's props don't churn (React.memo).
  const startEditing = useCallback((e: ChatMsg) => setEditingId(e.id), []);
  const cancelEditing = useCallback(() => setEditingId(undefined), []);

  // Keep the thread panel content mounted through its slide-out animation.
  useEffect(() => {
    if (threadRoot) {
      setLastThreadRoot(threadRoot);
      return;
    }
    const t = setTimeout(() => setLastThreadRoot(undefined), 200);
    return () => clearTimeout(t);
  }, [threadRoot]);

  // Mark the channel read up to the newest message while it's on screen.
  useEffect(() => {
    if (!user || messages.length === 0) return;
    const latest = messages[messages.length - 1]?.created_at ?? 0;
    if (latest <= 0) return;

    const stamp = () => {
      if (document.visibilityState === "visible") {
        markRead(channelReadKey(relayUrl, groupId), latest);
      }
    };
    stamp();
    document.addEventListener("visibilitychange", stamp);
    return () => document.removeEventListener("visibilitychange", stamp);
  }, [user, messages, relayUrl, groupId, markRead]);

  // Opening the thread panel (its width animates over ~200ms) and the footer
  // swapping between composer / membership skeleton / join prompt both resize
  // the timeline. Nothing to do here: the timeline observes its own scroller and
  // content, so it holds the reading position across every frame of both — this
  // used to be a rAF loop polling `maintainBottom` for 260ms.

  const handleSent = useCallback(() => {
    timelineRef.current?.pinToBottom();
  }, []);

  const openThread = useCallback((event: ChatMsg, focusReply = false) => {
    setThreadAutoFocus(focusReply);
    setThreadRoot(event);
  }, []);

  const handleSlashAction = useCallback(
    async (action: SlashAction) => {
      if (action.kind === "openThread") {
        const latest = messages[messages.length - 1];
        if (latest) openThread(latest, true);
        else toast({ title: "No message to thread", description: "Send a message first." });
        return;
      }
      if (action.kind === "kick" || action.kind === "ban") {
        await removeUser.mutateAsync({
          pubkey: action.pubkey,
          reason: action.kind === "ban" ? action.reason : undefined,
        });
        toast({ title: "User removed", description: "The user was removed from the channel." });
      }
    },
    [removeUser, messages, openThread],
  );

  const handleRetry = useCallback(
    async (event: NostrEvent) => {
      markFailed(event.id);
      try {
        // The timeline copy may have come from the event store, which drops
        // signatures; the outbox holds the signed one.
        await republish({ event: await withSignature(event), relay: relayUrl });
        markSent(event.id);
      } catch {
        markFailed(event.id);
      }
    },
    [republish, relayUrl, markSent, markFailed],
  );

  const handleDelete = useCallback(
    (event: NostrEvent) => {
      if (user?.pubkey === event.pubkey) {
        deleteOwnMessage({ event });
      } else {
        deleteEvent.mutate({ eventId: event.id });
      }
    },
    [user?.pubkey, deleteOwnMessage, deleteEvent],
  );

  const handleTogglePin = useCallback(
    async (event: NostrEvent) => {
      const pinned = isPinned(event.id);
      try {
        if (pinned) await unpin(event.id);
        else await pin(event.id);
      } catch {
        toast({
          title: pinned ? "Couldn't unpin" : "Couldn't pin",
          description: "The relay rejected the change.",
          variant: "destructive",
        });
      }
    },
    [isPinned, pin, unpin],
  );

  // Expose scrollToMessage to the parent (the pinned-messages popover).
  useEffect(() => {
    if (!scrollToMessageRef) return;
    scrollToMessageRef.current = (id: string) => timelineRef.current?.scrollToMessage(id);
    return () => {
      scrollToMessageRef.current = null;
    };
  }, [scrollToMessageRef]);

  const handleEditSubmit = useCallback(
    async (original: NostrRumor, content: string) => {
      const trimmed = content.trim();
      if (!trimmed || trimmed === original.content.trim()) {
        setEditingId(undefined);
        return;
      }
      setEditingId(undefined);
      try {
        const edited = await editMessage({ original, content: trimmed });
        if (edited && edited.id !== original.id) {
          removeOptimistic(original.id);
          insertOptimistic(edited);
          markSent(edited.id);
        }
      } catch {
        toast({
          title: "Edit failed",
          description: "The relay rejected the edit.",
          variant: "destructive",
        });
      }
    },
    [editMessage, removeOptimistic, insertOptimistic, markSent],
  );

  // Calendar events render inline in the timeline as event cards, alongside the
  // header's events bar. They come from a separate relay query (not
  // `useGroupMessages`), so merge them into a display timeline by created_at and
  // expose each event's RSVP state per id for the row's card.
  const calendarEvents = calendar?.events;
  const calendarMsgs = useMemo<ChatMsg[]>(
    () => (calendarEvents ?? []).map((c) => c.event as ChatMsg),
    [calendarEvents],
  );
  const timelineMessages = useMemo<ChatMsg[]>(() => {
    if (calendarMsgs.length === 0) return messages;
    return [...messages, ...calendarMsgs].sort((a, b) =>
      a.created_at !== b.created_at ? a.created_at - b.created_at : a.id < b.id ? -1 : 1,
    );
  }, [messages, calendarMsgs]);
  const calendarFor = useMemo(() => {
    if (!calendar) return undefined;
    const map = new Map<string, MessageCalendar>();
    for (const c of calendar.events) {
      map.set(c.event.id, {
        event: c,
        tally: calendar.rsvpsFor(c),
        canRsvp: calendar.canRsvp,
        isSettingRsvp: calendar.isSettingRsvp,
        setRsvp: (status) => calendar.setRsvp(c, status),
      });
    }
    return (id: string) => map.get(id);
  }, [calendar]);

  // Assemble the NIP-29 transport: the shared timeline/message components read
  // capabilities from here. Every method maps onto the existing NIP-29 hooks.
  const transport = useMemo<ChatTransport>(
    () => ({
      messages: timelineMessages,
      isLoading,
      canWrite: Boolean(user && canWrite),
      canModerate,
      loadOlder,
      hasMore,
      isLoadingOlder,
      sendStatusFor: (id) => sendStatus[id],
      retry: handleRetry,
      discard: removeOptimistic,
      deleteMessage: handleDelete,
      editMessage: async (original, content) => handleEditSubmit(original, content),
      isPinned,
      togglePin: handleTogglePin,
      replyCountFor,
      reactionsFor,
      zapsFor,
      calendarFor,
      openThread,
      threadRepliesFor,
      sendThreadReply: async (root, content, tags) => {
        await sendThreadReply(root, content, tags);
      },
    }),
    [
      timelineMessages,
      isLoading,
      user,
      canWrite,
      canModerate,
      loadOlder,
      hasMore,
      isLoadingOlder,
      sendStatus,
      handleRetry,
      removeOptimistic,
      handleDelete,
      handleEditSubmit,
      isPinned,
      handleTogglePin,
      replyCountFor,
      reactionsFor,
      zapsFor,
      calendarFor,
      openThread,
      threadRepliesFor,
      sendThreadReply,
    ],
  );

  return (
    <div className="relative flex flex-1 min-h-0 min-w-0">
      <ComposerBoundsProvider value={composerBoundsRef}>
      <div className={cn(
        "relative flex flex-col flex-1 min-h-0 min-w-0",
        "sidebar:transition-[width,opacity] sidebar:duration-300 sidebar:ease-out",
        threadRoot && threadExpanded && "sidebar:flex-none sidebar:w-0 sidebar:opacity-0 sidebar:overflow-hidden sidebar:pointer-events-none",
      )}>
        {/* Search results replace the timeline in-place when searching. */}
        {searching ? (
          <div className="flex-1 min-h-0 overflow-y-auto overflow-x-clip overscroll-contain scrollbar-stable px-3 py-4">
            {searchLoading ? (
              <div className="flex justify-center py-10">
                <Loader2 className="size-5 animate-spin text-muted-foreground" />
              </div>
            ) : searchResults.length === 0 ? (
              <div className="flex flex-col items-center justify-center py-16 text-center">
                <Search className="size-9 text-muted-foreground/40 mb-3" />
                <p className="text-sm text-muted-foreground">No messages found</p>
              </div>
            ) : (
              <>
                <p className="px-2 pb-1 text-[11px] uppercase tracking-wide text-muted-foreground/80">
                  {searchResults.length} result{searchResults.length === 1 ? "" : "s"}
                </p>
                {[...searchResults]
                  .sort((a, b) => a.created_at - b.created_at)
                  .map((msg) => (
                    <Nip29ChatMessage
                      key={msg.id}
                      event={msg}
                      relayUrl={relayUrl}
                      groupId={groupId}
                      transport={transport}
                      isEditing={false}
                      highlight={searchQuery}
                      continuation={false}
                      onEdit={(e) => setEditingId(e.id)}
                      onEditSubmit={handleEditSubmit}
                      onEditCancel={() => setEditingId(undefined)}
                      onJumpToReply={jumpToReply}
                      onReply={setReplyTo}
                    />
                  ))}
              </>
            )}
          </div>
        ) : (
          <MessageTimeline
            transport={transport}
            handleRef={timelineRef}
            newDividerId={newDividerId}
            className="flex-1 min-h-0"
            emptyState={
              <div className="flex flex-col items-center justify-center py-16 text-center">
                <Hash className="size-10 text-muted-foreground/40 mb-3" />
                <p className="text-sm text-muted-foreground">No messages yet</p>
                <p className="text-xs text-muted-foreground/60 mt-1">Be the first to say something!</p>
              </div>
            }
            renderMessage={(msg, continuation) => (
              <Nip29ChatMessage
                key={msg.id}
                event={msg}
                relayUrl={relayUrl}
                groupId={groupId}
                transport={transport}
                isEditing={editingId === msg.id}
                active={activeId === msg.id}
                onToggleActive={toggleActive}
                continuation={continuation}
                onEdit={startEditing}
                onEditSubmit={handleEditSubmit}
                onEditCancel={cancelEditing}
                onJumpToReply={jumpToReply}
                onReply={setReplyTo}
              />
            )}
          />
        )}

        {/* Composer — hidden while showing search results. */}
        {searching ? null : user && canWrite ? (
          <ChatComposer
            relayUrl={relayUrl}
            groupId={groupId}
            messages={messages}
            replyTo={replyTo}
            placeholder={channelName ? `Message ${channelName}` : undefined}
            onCancelReply={() => setReplyTo(undefined)}
            onSent={handleSent}
            onOptimisticInsert={insertOptimistic}
            onOptimisticSent={markSent}
            onOptimisticFailed={markFailed}
            canModerate={canModerate}
            botCommands
            onSlashAction={handleSlashAction}
          />
        ) : membershipPending ? (
          // Membership is still resolving — don't flash the "join to message"
          // prompt at an actual member. Show a composer-shaped skeleton (same
          // frame/padding/pill as ChatComposer) so the swap doesn't jump.
          <ComposerSkeleton />
        ) : (
          <div className="border-t p-3 shrink-0 pb-safe">
            {user ? (
              <p className="text-xs text-muted-foreground text-center py-1">
                Join this channel to send messages.
              </p>
            ) : (
              <p className="text-xs text-muted-foreground text-center py-1 flex items-center justify-center gap-1.5 flex-wrap">
                <Button
                  size="sm"
                  onClick={() => setJoinDialogOpen(true)}
                  className="clip-corner-lg h-7 touch:h-10 px-4"
                >
                  Join
                </Button>
                <span>to be a part of the chat</span>
              </p>
            )}
          </div>
        )}

        <LoginDialog
          isOpen={joinDialogOpen}
          onClose={() => setJoinDialogOpen(false)}
          onLogin={() => setJoinDialogOpen(false)}
          onSignupClick={() => {
            setJoinDialogOpen(false);
            setSignupDialogOpen(true);
          }}
        />
        <SignupDialog
          isOpen={signupDialogOpen}
          onClose={() => setSignupDialogOpen(false)}
        />
      </div>
      </ComposerBoundsProvider>

      {/* Thread panel. Desktop: in-flow sibling whose width animates open.
          Mobile: overlays the chat (absolute). */}
      <div
        className={cn(
          "overflow-hidden",
          "absolute inset-0 z-20 sidebar:static sidebar:z-auto",
          "sidebar:transition-[width] sidebar:duration-200 sidebar:ease-out",
          threadRoot
            ? (threadExpanded ? "sidebar:flex-1 sidebar:w-full" : "sidebar:shrink-0 sidebar:w-[23rem]")
            : "sidebar:shrink-0 sidebar:w-0 pointer-events-none sidebar:pointer-events-auto",
        )}
      >
        <div
          className={cn(
            "absolute inset-0 bg-background transition-opacity duration-200 ease-out sidebar:hidden",
            threadRoot ? "opacity-100" : "opacity-0",
          )}
        />
        <div
          className={cn(
            "relative h-full flex w-full transition-transform duration-200 ease-out",
            threadRoot ? "translate-x-0" : "translate-x-full",
            threadExpanded ? "sidebar:w-full" : "sidebar:w-[23rem]",
          )}
        >
          {lastThreadRoot && (
            <ThreadPanel
              root={lastThreadRoot}
              transport={transport}
              relayUrl={relayUrl}
              groupId={groupId}
              canWrite={Boolean(user && canWrite)}
              botCommands
              autoFocus={threadAutoFocus}
              onClose={() => { setThreadRoot(undefined); setThreadExpanded(false); }}
              onExpandChange={setThreadExpanded}
            />
          )}
        </div>
      </div>
    </div>
  );
}
