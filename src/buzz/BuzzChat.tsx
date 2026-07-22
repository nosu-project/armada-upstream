import { ArrowBigDown, ArrowBigUp, Bot as BotIcon, Hash, Loader2, Search } from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useSearchParams } from "react-router-dom";

import { BuzzDiffRow, BuzzHuddleRow, BuzzJobRow, BuzzSystemRow, BuzzWorkflowDefinitionRow, BuzzWorkflowEventRow } from "@/buzz/BuzzRows";
import {
  KIND_FORUM_COMMENT,
  KIND_FORUM_POST,
  KIND_FORUM_VOTE,
  KIND_HUDDLE_ENDED,
  KIND_HUDDLE_PARTICIPANT_JOINED,
  KIND_HUDDLE_PARTICIPANT_LEFT,
  KIND_HUDDLE_STARTED,
  KIND_JOB_ERROR,
  KIND_JOB_REQUEST,
  KIND_STREAM_MESSAGE_DIFF,
  KIND_STREAM_MESSAGE_V2,
  KIND_SYSTEM_MESSAGE,
  KIND_DELETE,
  KIND_WORKFLOW_DEFINITION,
  BUZZ_UNREAD_KINDS,
} from "@/buzz/kinds";
import { tallyForumVotes, collectDeletedIds } from "@/buzz/protocol";
import { buzzMessagesKey, useBuzzMessages } from "@/buzz/useBuzzMessages";
import { useBuzzEditMessage, useBuzzTyping, useSendBuzzThreadReply } from "@/buzz/useBuzzActions";
import { ChatComposer } from "@/components/chat/ChatComposer";
import { ChatMessage, ReplyContextLine, ReplyPreview, ReplyThumbnail } from "@/components/chat/ChatMessage";
import { firstImageRef, getReplyToId } from "@/components/chat/messageHelpers";
import { MessageTimeline, type MessageTimelineHandle } from "@/components/chat/MessageTimeline";
import { ThreadPanel } from "@/components/chat/ThreadPanel";
import { TypingIndicator } from "@/components/chat/TypingIndicator";
import { ComposerBoundsProvider } from "@/contexts/ComposerBoundsContext";
import { useAuthor } from "@/hooks/useAuthor";
import { useAppContext } from "@/hooks/useAppContext";
import { useCurrentUser } from "@/hooks/useCurrentUser";
import { useGroup } from "@/hooks/useGroup";
import { useGroupModeration } from "@/hooks/useGroupModeration";
import { useGroupSearch } from "@/hooks/useGroupSearch";
import { useDeleteOwnMessage } from "@/hooks/useEditMessage";
import { useGroupReactions } from "@/hooks/useReactions";
import { useZapReceipts } from "@/hooks/useZapReceipts";
import { useNostrPublish, useRepublish } from "@/hooks/useNostrPublish";
import { useActiveRoom } from "@/hooks/useActiveRoom";
import { useNewMessagesDivider } from "@/hooks/useNewMessagesDivider";
import { channelReadKey, useReadState } from "@/hooks/useReadState";
import { toast } from "@/hooks/useToast";
import { useScopedDisplayName } from "@/hooks/useScopedDisplayName";
import { useEvent } from "@/hooks/useEvent";
import { type SlashAction } from "@/lib/slashCommands";
import { cn } from "@/lib/utils";

import { threadSummary } from "@/components/chat/transport";
import type { ChatMsg, ChatTransport } from "@/components/chat/transport";
import type { NostrEvent } from "@nostrify/nostrify";

/** Buzz reply context: fetch the replied-to event and render the shared chrome. */
function ReplyContext({ eventId, relayUrl, onJump }: { eventId: string; relayUrl: string; onJump: (id: string) => void }) {
  const { data: event } = useEvent(eventId, [relayUrl]);
  const author = useAuthor(event?.pubkey);
  const displayName = useScopedDisplayName(event?.pubkey, author.data?.metadata);

  if (!event) return null;

  const image = firstImageRef(event);
  return (
    <ReplyContextLine
      name={displayName}
      preview={<ReplyPreview content={event.content} hideMediaPlaceholder={!!image} />}
      thumbnail={image ? <ReplyThumbnail image={image} /> : undefined}
      onClick={() => onJump(eventId)}
    />
  );
}

/** Chat-like kinds that render through the shared ChatMessage row. */
function isChatRow(kind: number): boolean {
  return kind === 9 || kind === 40001 || kind === KIND_STREAM_MESSAGE_V2 || kind === KIND_FORUM_POST;
}

interface BuzzChatMessageProps {
  event: ChatMsg;
  relayUrl: string;
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
  /** Forum vote bar (forum channels only). */
  votes?: { up: number; down: number; mine?: "+" | "-" };
  onVote?: (event: ChatMsg, value: "+" | "-") => void;
  /** Whether the author holds the `bot` role in this channel (agent badge). */
  isAgent?: boolean;
}

/**
 * Buzz binding for one chat-like row. Mirrors Nip29ChatMessage: per-room
 * batched reactions/threads read off the transport, rendered through the
 * shared presentational ChatMessage.
 */
function BuzzChatMessage({
  event,
  relayUrl,
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
  votes,
  onVote,
  isAgent,
}: BuzzChatMessageProps) {
  const { config } = useAppContext();
  const threadInfo = threadSummary(transport.threadRepliesFor?.(event.id) ?? []);
  const replyToId = getReplyToId(event);
  return (
    <div>
      <ChatMessage
        event={event}
        canWrite={transport.canWrite}
        canModerate={transport.canModerate}
        reactions={transport.reactionsFor?.(event.id)}
        zapEnabled={config.zapsEnabled && Boolean(transport.zapsFor)}
        zaps={transport.zapsFor?.(event.id)}
        sendStatus={transport.sendStatusFor?.(event.id)}
        highlight={highlight}
        isEditing={isEditing}
        replyCount={transport.replyCountFor?.(event.id) ?? 0}
        threadParticipants={threadInfo.participants}
        lastReplyAt={threadInfo.lastReplyAt}
        replyContext={
          replyToId
            ? <ReplyContext eventId={replyToId} relayUrl={relayUrl} onJump={onJumpToReply} />
            : undefined
        }
        nameBadge={
          isAgent ? (
            <span className="inline-flex items-center gap-0.5 rounded-full bg-primary/15 px-1.5 py-px text-[10px] font-medium text-primary align-middle">
              <BotIcon className="size-2.5" aria-hidden />
              Agent
            </span>
          ) : undefined
        }
        onRetry={() => transport.retry?.(event)}
        onDiscard={() => transport.discard?.(event.id)}
        onDelete={transport.deleteMessage}
        onOpenThread={transport.openThread ? (e) => transport.openThread!(e, true) : undefined}
        onReply={onReply}
        onEdit={onEdit}
        onEditSubmit={onEditSubmit}
        onEditCancel={onEditCancel}
        active={active}
        onToggleActive={onToggleActive}
        continuation={continuation}
      />
      {votes && onVote && (
        <div className="flex items-center gap-1 pl-14 pb-1 -mt-0.5">
          <button
            type="button"
            aria-label="Upvote"
            aria-pressed={votes.mine === "+"}
            className={cn(
              "flex items-center gap-0.5 px-1.5 py-0.5 rounded text-xs transition-colors",
              votes.mine === "+" ? "text-success bg-success/10" : "text-muted-foreground hover:text-foreground",
            )}
            onClick={() => onVote(event, "+")}
          >
            <ArrowBigUp className="size-4" />
            {votes.up > 0 && votes.up}
          </button>
          <button
            type="button"
            aria-label="Downvote"
            aria-pressed={votes.mine === "-"}
            className={cn(
              "flex items-center gap-0.5 px-1.5 py-0.5 rounded text-xs transition-colors",
              votes.mine === "-" ? "text-destructive bg-destructive/10" : "text-muted-foreground hover:text-foreground",
            )}
            onClick={() => onVote(event, "-")}
          >
            <ArrowBigDown className="size-4" />
            {votes.down > 0 && votes.down}
          </button>
        </div>
      )}
    </div>
  );
}

interface BuzzChatProps {
  relayUrl: string;
  channelId: string;
  /** Buzz channel type: forum channels swap the content kinds + add votes. */
  channelType?: "stream" | "forum" | "dm" | "workflow";
  canWrite: boolean;
  membershipPending?: boolean;
  canModerate: boolean;
  searchQuery?: string;
  scrollToMessageRef?: React.MutableRefObject<((id: string) => void) | null>;
}

/**
 * The message timeline + composer for a channel on a Buzz relay. Buzz is
 * NIP-29-based, so the surface mirrors {@link GroupChat} — but with the Buzz
 * protocol semantics: extra row kinds (system messages, diffs, job lifecycle,
 * huddle cards), kind-40003 edits folded onto their targets, NIP-10 marked
 * kind-9 THREAD replies (with `broadcast` surfacing), forum posts with votes,
 * and live typing indicators (ephemeral kind 20002).
 */
export function BuzzChat({
  relayUrl,
  channelId,
  channelType = "stream",
  canWrite,
  membershipPending = false,
  canModerate,
  searchQuery = "",
  scrollToMessageRef,
}: BuzzChatProps) {
  const { user } = useCurrentUser();
  const composerBoundsRef = useRef<HTMLElement | null>(null);
  const { data: groupDetails } = useGroup(relayUrl, channelId);
  const channelName = groupDetails?.group?.name;
  const memberRoles = groupDetails?.memberRoles;
  const forum = channelType === "forum";
  const workflow = channelType === "workflow";

  const {
    timeline,
    raw,
    isLoading,
    status: sendStatus,
    insertOptimistic,
    markSent,
    markFailed,
    removeOptimistic,
    loadOlder,
    hasMore,
    isLoadingOlder,
    replyCountFor,
    threadRepliesFor: threadRepliesForRaw,
    fetchThread,
    mergeEvents,
  } = useBuzzMessages(relayUrl, channelId, { forum, workflow });

  const { deleteEvent, removeUser } = useGroupModeration(relayUrl, channelId);
  const { mutateAsync: republish } = useRepublish();
  const { mutateAsync: editMessage } = useBuzzEditMessage(relayUrl, channelId);
  const { mutate: deleteOwnMessage } = useDeleteOwnMessage(relayUrl, channelId);
  const { mutateAsync: publish } = useNostrPublish();
  const { markRead } = useReadState();
  const { typers, publishTyping } = useBuzzTyping(relayUrl, channelId);

  const newDividerId = useNewMessagesDivider(
    channelReadKey(relayUrl, channelId),
    timeline,
    user?.pubkey,
  );

  const { results: searchResults, isLoading: searchLoading, active: searching } = useGroupSearch(
    relayUrl,
    channelId,
    searchQuery,
    { kinds: [...BUZZ_UNREAD_KINDS], messagesKey: buzzMessagesKey(relayUrl, channelId) },
  );

  const visibleIds = useMemo(() => {
    const set = new Set<string>();
    for (const m of timeline) set.add(m.id);
    for (const m of searchResults) set.add(m.id);
    return [...set];
  }, [timeline, searchResults]);

  const sendThreadReply = useSendBuzzThreadReply(
    relayUrl,
    channelId,
    forum ? KIND_FORUM_COMMENT : undefined,
  );

  const [activeId, setActiveId] = useState<string | undefined>(undefined);
  const toggleActive = useCallback(
    (id: string) => setActiveId((cur) => (cur === id ? undefined : id)),
    [],
  );
  const [threadRoot, setThreadRoot] = useState<NostrEvent | undefined>(undefined);

  useActiveRoom(
    relayUrl && channelId ? `h:${relayUrl}|${channelId}` : undefined,
    relayUrl && channelId && threadRoot ? `h:${relayUrl}|${channelId}:t:${threadRoot.id}` : undefined,
  );

  // Notification deep-link into a thread (`?thread=<rootId>`).
  const [searchParams, setSearchParams] = useSearchParams();
  const threadParam = searchParams.get("thread");
  useEffect(() => {
    if (!threadParam || threadRoot) return;
    const root = timeline.find((m) => m.id === threadParam);
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
  }, [threadParam, threadRoot, timeline, setSearchParams]);

  // Tallies resolve over the timeline PLUS the open thread's replies.
  const tallyIds = useMemo(() => {
    if (!threadRoot) return visibleIds;
    const replyIds = threadRepliesForRaw(threadRoot.id).map((r) => r.id);
    if (replyIds.length === 0) return visibleIds;
    return [...new Set([...visibleIds, ...replyIds])];
  }, [visibleIds, threadRoot, threadRepliesForRaw]);

  const { reactionsFor } = useGroupReactions(relayUrl, channelId, tallyIds, {
    messagesKey: buzzMessagesKey(relayUrl, channelId),
  });
  const { zapsFor } = useZapReceipts(
    relayUrl && channelId ? `buzz:${relayUrl}:${channelId}` : undefined,
    tallyIds,
  );

  // Forum votes (45002) tallied from the raw window.
  const voteTallies = useMemo(() => {
    if (!forum) return undefined;
    const deleted = collectDeletedIds(raw);
    const votes = raw.filter((e) => e.kind === KIND_FORUM_VOTE && !deleted.has(e.id));
    return tallyForumVotes(votes, user?.pubkey);
  }, [forum, raw, user?.pubkey]);

  const handleVote = useCallback(
    async (target: ChatMsg, value: "+" | "-") => {
      const mine = voteTallies?.get(target.id)?.mine;
      try {
        if (mine && mine.value === value) {
          // Retract: NIP-09 delete of the prior vote.
          await publish({
            kind: KIND_DELETE,
            content: "",
            tags: [["e", mine.eventId], ["k", String(KIND_FORUM_VOTE)], ["h", channelId]],
            relay: relayUrl,
            onSigned: (ev) => mergeEvents([ev]),
          });
        } else {
          await publish({
            kind: KIND_FORUM_VOTE,
            content: value,
            tags: [["h", channelId], ["e", target.id], ["p", target.pubkey]],
            relay: relayUrl,
            onSigned: (ev) => mergeEvents([ev]),
          });
        }
      } catch {
        toast({ title: "Vote failed", description: "The relay rejected the vote.", variant: "destructive" });
      }
    },
    [voteTallies, publish, channelId, relayUrl, mergeEvents],
  );

  const [threadAutoFocus, setThreadAutoFocus] = useState(false);
  const [threadExpanded, setThreadExpanded] = useState(false);
  const [lastThreadRoot, setLastThreadRoot] = useState<NostrEvent | undefined>(undefined);
  const [replyTo, setReplyTo] = useState<NostrEvent | undefined>(undefined);
  const [editingId, setEditingId] = useState<string | undefined>(undefined);
  const timelineRef = useRef<MessageTimelineHandle | null>(null);

  const jumpToReply = useCallback((id: string) => {
    timelineRef.current?.scrollToMessage(id);
  }, []);

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
    if (!user || timeline.length === 0) return;
    const latest = timeline[timeline.length - 1]?.created_at ?? 0;
    if (latest <= 0) return;
    const stamp = () => {
      if (document.visibilityState === "visible") {
        markRead(channelReadKey(relayUrl, channelId), latest);
      }
    };
    stamp();
    document.addEventListener("visibilitychange", stamp);
    return () => document.removeEventListener("visibilitychange", stamp);
  }, [user, timeline, relayUrl, channelId, markRead]);

  // Re-pin to bottom across panel/footer reflows (mirrors GroupChat).
  useEffect(() => {
    let rafId = 0;
    const start = performance.now();
    const pin = (now: number) => {
      timelineRef.current?.maintainBottom();
      if (now - start < 260) rafId = requestAnimationFrame(pin);
    };
    rafId = requestAnimationFrame(pin);
    return () => cancelAnimationFrame(rafId);
  }, [threadRoot, canWrite, membershipPending, searching]);

  const handleSent = useCallback(() => {
    timelineRef.current?.pinToBottom();
  }, []);

  const openThread = useCallback((event: NostrEvent, focusReply = false) => {
    setThreadAutoFocus(focusReply);
    setThreadRoot(event);
    // Backfill the full thread by `#e` reference — the loaded `#h` window may
    // not span an old thread's replies.
    void fetchThread(event.id);
  }, [fetchThread]);

  const handleSlashAction = useCallback(
    async (action: SlashAction) => {
      if (action.kind === "openThread") {
        const latest = timeline[timeline.length - 1];
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
    [removeUser, timeline, openThread],
  );

  const handleRetry = useCallback(
    async (event: NostrEvent) => {
      markFailed(event.id);
      try {
        await republish({ event, relay: relayUrl });
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

  useEffect(() => {
    if (!scrollToMessageRef) return;
    scrollToMessageRef.current = (id: string) => timelineRef.current?.scrollToMessage(id);
    return () => {
      scrollToMessageRef.current = null;
    };
  }, [scrollToMessageRef]);

  const handleEditSubmit = useCallback(
    async (original: NostrEvent, content: string) => {
      const trimmed = content.trim();
      if (!trimmed || trimmed === original.content.trim()) {
        setEditingId(undefined);
        return;
      }
      setEditingId(undefined);
      try {
        const edit = await editMessage({ original, content: trimmed });
        // Fold the edit in immediately (the wire echo lands later).
        if (edit.id !== original.id) mergeEvents([edit]);
      } catch {
        toast({
          title: "Edit failed",
          description: "The relay rejected the edit.",
          variant: "destructive",
        });
      }
    },
    [editMessage, mergeEvents],
  );

  // Thread replies adapted to ChatMsg (they already are NostrEvents).
  const threadRepliesFor = useCallback(
    (rootId: string): ChatMsg[] => threadRepliesForRaw(rootId),
    [threadRepliesForRaw],
  );

  // Huddle lifecycle overlays for the 48100 session cards.
  const huddleLifecycle = useMemo(
    () =>
      raw.filter(
        (e) =>
          e.kind === KIND_HUDDLE_PARTICIPANT_JOINED ||
          e.kind === KIND_HUDDLE_PARTICIPANT_LEFT ||
          e.kind === KIND_HUDDLE_ENDED,
      ),
    [raw],
  );

  const transport = useMemo<ChatTransport>(
    () => ({
      messages: timeline,
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
      replyCountFor,
      reactionsFor,
      zapsFor,
      openThread,
      threadRepliesFor,
      sendThreadReply: async (root, content, tags) => {
        await sendThreadReply(root, content, tags);
      },
    }),
    [
      timeline,
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
      replyCountFor,
      reactionsFor,
      zapsFor,
      openThread,
      threadRepliesFor,
      sendThreadReply,
    ],
  );

  const renderRow = useCallback(
    (msg: ChatMsg, continuation: boolean, highlight?: string) => {
      if (msg.kind === KIND_SYSTEM_MESSAGE) return <BuzzSystemRow key={msg.id} event={msg} />;
      if (msg.kind === KIND_STREAM_MESSAGE_DIFF) return <BuzzDiffRow key={msg.id} event={msg} />;
      if (msg.kind >= KIND_JOB_REQUEST && msg.kind <= KIND_JOB_ERROR) {
        return <BuzzJobRow key={msg.id} event={msg} />;
      }
      if (msg.kind === KIND_HUDDLE_STARTED) {
        return <BuzzHuddleRow key={msg.id} event={msg} lifecycle={huddleLifecycle} />;
      }
      if (msg.kind === KIND_WORKFLOW_DEFINITION) {
        return <BuzzWorkflowDefinitionRow key={msg.id} event={msg} />;
      }
      if ((msg.kind >= 46001 && msg.kind <= 46012) || msg.kind === 46020) {
        return <BuzzWorkflowEventRow key={msg.id} event={msg} />;
      }
      if (!isChatRow(msg.kind)) return <BuzzSystemRow key={msg.id} event={msg} />;
      const votes = forum ? voteTallies?.get(msg.id) ?? { up: 0, down: 0 } : undefined;
      return (
        <BuzzChatMessage
          key={msg.id}
          event={msg}
          relayUrl={relayUrl}
          transport={transport}
          isAgent={memberRoles?.[msg.pubkey] === "bot"}
          isEditing={editingId === msg.id}
          highlight={highlight}
          active={activeId === msg.id}
          onToggleActive={toggleActive}
          continuation={continuation}
          onEdit={(e) => setEditingId(e.id)}
          onEditSubmit={handleEditSubmit}
          onEditCancel={() => setEditingId(undefined)}
          onJumpToReply={jumpToReply}
          onReply={setReplyTo}
          votes={votes ? { up: votes.up, down: votes.down, mine: votes.mine?.value } : undefined}
          onVote={forum ? handleVote : undefined}
        />
      );
    },
    [
      huddleLifecycle,
      forum,
      voteTallies,
      relayUrl,
      transport,
      memberRoles,
      editingId,
      activeId,
      toggleActive,
      handleEditSubmit,
      jumpToReply,
      handleVote,
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
                  .map((msg) => renderRow(msg, false, searchQuery))}
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
            renderMessage={(msg, continuation) => renderRow(msg, continuation)}
          />
        )}

        {/* Live typing indicators (ephemeral kind 20002). */}
        {!searching && <TypingIndicator pubkeys={typers} />}

        {searching ? null : user && canWrite ? (
          <ChatComposer
            relayUrl={relayUrl}
            groupId={channelId}
            messages={timeline}
            replyTo={replyTo}
            replyMarker="buzz"
            replyExtraTags={BROADCAST_TAGS}
            messageKind={forum ? KIND_FORUM_POST : undefined}
            pollsEnabled={false}
            placeholder={channelName ? `Message ${channelName}` : undefined}
            onCancelReply={() => setReplyTo(undefined)}
            onSent={handleSent}
            onOptimisticInsert={insertOptimistic}
            onOptimisticSent={markSent}
            onOptimisticFailed={markFailed}
            canModerate={canModerate}
            onTyping={publishTyping}
            onSlashAction={handleSlashAction}
          />
        ) : membershipPending ? (
          <div className="p-2" aria-hidden>
            <div className="h-12 clip-corner-lg bg-secondary/60" />
          </div>
        ) : (
          <div className="border-t p-3 shrink-0 pb-safe">
            <p className="text-xs text-muted-foreground text-center py-1">
              {user ? "Join this channel to send messages." : "Sign in to join the conversation."}
            </p>
          </div>
        )}
      </div>
      </ComposerBoundsProvider>

      {/* Thread panel (Buzz threads = NIP-10 marked kind-9 replies). */}
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
              groupId={channelId}
              canWrite={Boolean(user && canWrite)}
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

/** Stable tag array: an inline Buzz reply broadcasts onto the main timeline. */
const BROADCAST_TAGS: string[][] = [["broadcast", "1"]];
