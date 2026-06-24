import { Hash, Loader2, Reply, Search } from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import { ChatComposer } from "@/components/chat/ChatComposer";
import { ChatMessage, getReplyToId } from "@/components/chat/ChatMessage";
import { MessageTimeline, type MessageTimelineHandle } from "@/components/chat/MessageTimeline";
import { ThreadPanel } from "@/components/chat/ThreadPanel";
import LoginDialog from "@/components/auth/LoginDialog";
import SignupDialog from "@/components/auth/SignupDialog";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { useAuthor } from "@/hooks/useAuthor";
import { useCurrentUser } from "@/hooks/useCurrentUser";
import { useEvent } from "@/hooks/useEvent";
import { useGroupMessages } from "@/hooks/useGroupMessages";
import { useGroupModeration } from "@/hooks/useGroupModeration";
import { useGroupSearch } from "@/hooks/useGroupSearch";
import { useDeleteOwnMessage, useEditMessage } from "@/hooks/useEditMessage";
import { usePinnedMessages } from "@/hooks/usePinnedMessages";
import { useReactions } from "@/hooks/useReactions";
import { useReplyCount } from "@/hooks/useThread";
import { useRepublish } from "@/hooks/useNostrPublish";
import { channelReadKey, useReadState } from "@/hooks/useReadState";
import { toast } from "@/hooks/useToast";
import { useScopedDisplayName } from "@/hooks/useScopedDisplayName";
import { type SlashAction } from "@/lib/slashCommands";
import { cn } from "@/lib/utils";

import type { ChatMsg, ChatTransport } from "@/components/chat/transport";
import type { NostrEvent } from "@nostrify/nostrify";

/** Compact "replying to" context line shown above a NIP-29 reply message. */
function ReplyContext({ eventId, relayUrl }: { eventId: string; relayUrl: string }) {
  const { data: event } = useEvent(eventId, [relayUrl]);
  const author = useAuthor(event?.pubkey);
  const displayName = useScopedDisplayName(event?.pubkey, author.data?.metadata);

  if (!event) return null;

  const preview = event.content.replace(/https?:\/\/\S+/g, "📎").trim() || "📎";

  return (
    <div className="flex items-center gap-1.5 text-[11px] text-muted-foreground/80 mb-0.5 min-w-0">
      <Reply className="size-3 shrink-0" />
      <span className="font-semibold shrink-0">{displayName}</span>
      <span className="truncate">{preview}</span>
    </div>
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
  onReply: (event: ChatMsg) => void;
  onEdit: (event: ChatMsg) => void;
  onEditSubmit: (event: ChatMsg, content: string) => void;
  onEditCancel: () => void;
}

/**
 * NIP-29 binding for a single message: resolves this message's reactions and
 * threaded-reply count from the group's host relay, then renders the shared
 * presentational {@link ChatMessage}. This is the only place per-message NIP-29
 * relay hooks are called; everything below it is transport-agnostic.
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
  onReply,
  onEdit,
  onEditSubmit,
  onEditCancel,
}: Nip29ChatMessageProps) {
  const { tallies, react } = useReactions(event, relayUrl, groupId);
  const replyCount = useReplyCount(event.id, relayUrl, groupId);

  return (
    <ChatMessage
      event={event}
      canWrite={transport.canWrite}
      canModerate={transport.canModerate}
      pollContext={{ relayUrl, groupId }}
      reactions={{ tallies, react }}
      sendStatus={transport.sendStatusFor?.(event.id)}
      highlight={highlight}
      isEditing={isEditing}
      isPinned={transport.isPinned?.(event.id)}
      replyCount={replyCount}
      replyContext={<ReplyContext eventId={getReplyToId(event) ?? ""} relayUrl={relayUrl} />}
      onRetry={() => transport.retry?.(event)}
      onDiscard={() => transport.discard?.(event.id)}
      onTogglePin={transport.togglePin}
      onDelete={transport.deleteMessage}
      onReply={onReply}
      onOpenThread={transport.openThread ? (e) => transport.openThread!(e) : undefined}
      onEdit={onEdit}
      onEditSubmit={onEditSubmit}
      onEditCancel={onEditCancel}
      active={active}
      onToggleActive={onToggleActive}
      continuation={continuation}
    />
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
export function GroupChat({ relayUrl, groupId, canWrite, membershipPending = false, canModerate, searchQuery = "", scrollToMessageRef }: GroupChatProps) {
  const { user } = useCurrentUser();
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
  const { isPinned, pin, unpin } = usePinnedMessages(relayUrl, groupId);
  const { mutateAsync: republish } = useRepublish();
  const { mutateAsync: editMessage } = useEditMessage(relayUrl, groupId);
  const { mutate: deleteOwnMessage } = useDeleteOwnMessage(relayUrl, groupId);
  const { markRead } = useReadState();
  const { results: searchResults, isLoading: searchLoading, active: searching } = useGroupSearch(
    relayUrl,
    groupId,
    searchQuery,
  );
  const [replyTo, setReplyTo] = useState<NostrEvent | undefined>(undefined);
  // The single message whose tap-to-reveal toolbar is open (mobile only).
  const [activeId, setActiveId] = useState<string | undefined>(undefined);
  const toggleActive = useCallback(
    (id: string) => setActiveId((cur) => (cur === id ? undefined : id)),
    [],
  );
  const [threadRoot, setThreadRoot] = useState<NostrEvent | undefined>(undefined);
  const [threadAutoFocus, setThreadAutoFocus] = useState(false);
  const [lastThreadRoot, setLastThreadRoot] = useState<NostrEvent | undefined>(undefined);
  const [editingId, setEditingId] = useState<string | undefined>(undefined);
  const [joinDialogOpen, setJoinDialogOpen] = useState(false);
  const [signupDialogOpen, setSignupDialogOpen] = useState(false);
  const timelineRef = useRef<MessageTimelineHandle | null>(null);

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

  // Opening/closing the thread panel reflows the message column (its width
  // animates over ~200ms). While it animates, keep the scroll pinned to the
  // bottom if the user was already there.
  useEffect(() => {
    let raf = 0;
    const start = performance.now();
    const pin = (now: number) => {
      timelineRef.current?.maintainBottom();
      if (now - start < 260) raf = requestAnimationFrame(pin);
    };
    raf = requestAnimationFrame(pin);
    return () => cancelAnimationFrame(raf);
  }, [threadRoot]);

  // The footer below the timeline (composer / membership skeleton / join
  // prompt) changes height when membership resolves or search toggles, which
  // resizes the timeline. Re-pin to the bottom across that swap so a pinned
  // view doesn't jump.
  useEffect(() => {
    let raf = 0;
    const start = performance.now();
    const pin = (now: number) => {
      timelineRef.current?.maintainBottom();
      if (now - start < 260) raf = requestAnimationFrame(pin);
    };
    raf = requestAnimationFrame(pin);
    return () => cancelAnimationFrame(raf);
  }, [canWrite, membershipPending, searching]);

  const handleSent = useCallback(() => {
    setReplyTo(undefined);
    timelineRef.current?.pinToBottom();
  }, []);

  const openThread = useCallback((event: NostrEvent, focusReply = false) => {
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
    async (original: NostrEvent, content: string) => {
      const trimmed = content.trim();
      if (!trimmed || trimmed === original.content.trim()) {
        setEditingId(undefined);
        return;
      }
      setEditingId(undefined);
      try {
        const edited = await editMessage({ original, content: trimmed });
        if (edited.id !== original.id) {
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

  // Assemble the NIP-29 transport: the shared timeline/message components read
  // capabilities from here. Every method maps onto the existing NIP-29 hooks.
  const transport = useMemo<ChatTransport>(
    () => ({
      messages,
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
      replyCountFor: undefined, // resolved per-row by useReplyCount
      openThread,
    }),
    [
      messages,
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
      openThread,
    ],
  );

  return (
    <div className="relative flex flex-1 min-h-0 min-w-0">
      <div className="relative flex flex-col flex-1 min-h-0 min-w-0">
        {/* Search results replace the timeline in-place when searching. */}
        {searching ? (
          <div className="flex-1 min-h-0 overflow-y-auto overflow-x-hidden overscroll-contain scrollbar-stable px-3 py-4">
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
                      onReply={setReplyTo}
                      onEdit={(e) => setEditingId(e.id)}
                      onEditSubmit={handleEditSubmit}
                      onEditCancel={() => setEditingId(undefined)}
                    />
                  ))}
              </>
            )}
          </div>
        ) : (
          <MessageTimeline
            transport={transport}
            handleRef={timelineRef}
            className="flex-1 min-h-0 overflow-y-auto overflow-x-hidden overscroll-contain scrollbar-stable px-3 py-4"
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
                onReply={setReplyTo}
                onEdit={(e) => setEditingId(e.id)}
                onEditSubmit={handleEditSubmit}
                onEditCancel={() => setEditingId(undefined)}
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
            onCancelReply={() => setReplyTo(undefined)}
            onSent={handleSent}
            onOptimisticInsert={insertOptimistic}
            onOptimisticSent={markSent}
            onOptimisticFailed={markFailed}
            canModerate={canModerate}
            onSlashAction={handleSlashAction}
          />
        ) : membershipPending ? (
          // Membership is still resolving — don't flash the "join to message"
          // prompt at an actual member. Show a composer-shaped skeleton, sized
          // close to the real composer so the swap doesn't jump the scroll.
          <div className="border-t p-3 shrink-0 pb-safe">
            <Skeleton className="h-9 w-full rounded-md" />
          </div>
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
                  className="clip-corner-lg h-7 px-4"
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

      {/* Thread panel. Desktop: in-flow sibling whose width animates open.
          Mobile: overlays the chat (absolute). */}
      <div
        className={cn(
          "overflow-hidden",
          "absolute inset-0 z-20 sidebar:static sidebar:z-auto",
          "sidebar:shrink-0 sidebar:w-0 sidebar:transition-[width] sidebar:duration-200 sidebar:ease-out",
          threadRoot ? "sidebar:w-[23rem]" : "pointer-events-none sidebar:pointer-events-auto",
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
            "relative h-full flex w-full sidebar:w-[23rem] transition-transform duration-200 ease-out",
            threadRoot ? "translate-x-0" : "translate-x-full",
          )}
        >
          {lastThreadRoot && (
            <ThreadPanel
              root={lastThreadRoot}
              relayUrl={relayUrl}
              groupId={groupId}
              canWrite={Boolean(user && canWrite)}
              autoFocus={threadAutoFocus}
              onClose={() => setThreadRoot(undefined)}
            />
          )}
        </div>
      </div>
    </div>
  );
}
