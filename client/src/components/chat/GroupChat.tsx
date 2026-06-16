import { AlertCircle, Hash, Loader2, MessagesSquare, Pencil, Pin, PinOff, Reply, Search, Trash2 } from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";

import { ChatComposer } from "@/components/chat/ChatComposer";
import { ChatContent } from "@/components/chat/ChatContent";
import { MessageRow } from "@/components/chat/MessageRow";
import { PollCard } from "@/components/chat/PollCard";
import { ReactionBar, ReactionPicker } from "@/components/chat/ReactionBar";
import { ThreadPanel } from "@/components/chat/ThreadPanel";
import LoginDialog from "@/components/auth/LoginDialog";
import SignupDialog from "@/components/auth/SignupDialog";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
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
import { useRepublish } from "@/hooks/useNostrPublish";import { channelReadKey, useReadState } from "@/hooks/useReadState";
import { toast } from "@/hooks/useToast";
import { getDisplayName } from "@/lib/getDisplayName";
import { KIND_GROUP_CHAT } from "@/lib/nip29";
import { isMeAction, meActionText, type SlashAction } from "@/lib/slashCommands";
import { cn } from "@/lib/utils";

import type { SendStatus } from "@/hooks/useGroupMessages";

import type { NostrEvent } from "@nostrify/nostrify";

/** NIP-88 poll kind. */
const KIND_POLL = 1068;

/** Extract the id of the message this event replies to (NIP-10 marked e tags). */
function getReplyToId(event: NostrEvent): string | undefined {
  const replyTag = event.tags.find(([name, , , marker]) => name === "e" && marker === "reply");
  if (replyTag) return replyTag[1];
  const rootTag = event.tags.find(([name, , , marker]) => name === "e" && marker === "root");
  return rootTag?.[1];
}

/** Compact "replying to" context line shown above a reply message. */
function ReplyContext({ eventId, relayUrl }: { eventId: string; relayUrl: string }) {
  const { data: event } = useEvent(eventId, [relayUrl]);
  const author = useAuthor(event?.pubkey);

  if (!event) return null;

  const displayName = getDisplayName(author.data?.metadata, event.pubkey);
  const preview = event.content.replace(/https?:\/\/\S+/g, "📎").trim() || "📎";

  return (
    <div className="flex items-center gap-1.5 text-[11px] text-muted-foreground/80 mb-0.5 min-w-0">
      <Reply className="size-3 shrink-0" />
      <span className="font-semibold shrink-0">{displayName}</span>
      <span className="truncate">{preview}</span>
    </div>
  );
}

interface ChatMessageProps {
  event: NostrEvent;
  relayUrl: string;
  groupId: string;
  canWrite: boolean;
  canModerate: boolean;
  /** Optimistic send status, if this message is locally-published & unconfirmed. */
  sendStatus?: SendStatus;
  /** Search term to highlight in the message body (search-results mode). */
  highlight?: string;
  /** Whether this message is currently being edited inline. */
  isEditing?: boolean;
  /** Whether this message is currently pinned (admins only see the control). */
  isPinned?: boolean;
  onRetry?: () => void;
  onDiscard?: () => void;
  /** Pin or unpin this message (admins/moderators only). */
  onTogglePin?: (event: NostrEvent) => void;
  /** Delete this message. Self-deletes publish NIP-09 (kind 5); moderator
   *  deletes of others' messages use the NIP-29 moderation event. */
  onDelete: (event: NostrEvent) => void;
  onReply: (event: NostrEvent) => void;
  /** Open the threaded-replies side panel for this message. */
  onOpenThread?: (event: NostrEvent) => void;
  /** Begin editing this message (own, non-poll messages only). */
  onEdit?: (event: NostrEvent) => void;
  /** Submit an inline edit with new content. */
  onEditSubmit?: (event: NostrEvent, content: string) => void;
  /** Cancel an in-progress inline edit. */
  onEditCancel?: () => void;
}

function ChatMessage({ event, relayUrl, groupId, canWrite, canModerate, sendStatus, highlight, isEditing, isPinned, onRetry, onDiscard, onTogglePin, onDelete, onReply, onOpenThread, onEdit, onEditSubmit, onEditCancel }: ChatMessageProps) {
  const { user } = useCurrentUser();
  const author = useAuthor(event.pubkey);
  const displayName = getDisplayName(author.data?.metadata, event.pubkey);
  const replyToId = getReplyToId(event);
  const { tallies, react } = useReactions(event, relayUrl, groupId);
  const replyCount = useReplyCount(event.id, relayUrl, groupId);
  const isPending = sendStatus === "pending";
  const isFailed = sendStatus === "failed";
  const isOwn = user?.pubkey === event.pubkey;
  // Highlight messages that mention you or reply to you: both add a `p` tag for
  // the current user (NIP-27 mention / NIP-10 reply). Not your own messages.
  const mentionsMe = Boolean(
    user && !isOwn && event.tags.some(([name, value]) => name === "p" && value === user.pubkey),
  );
  // Only plain chat messages are editable (polls carry structured tags).
  const canEdit = isOwn && event.kind === KIND_GROUP_CHAT && !isPending && !isFailed;
  // The author can delete their own confirmed message (NIP-09 kind 5);
  // moderators can delete anyone's (NIP-29 moderation event).
  const canDelete = (isOwn && !isPending && !isFailed) || canModerate;
  // Admins/moderators can pin any confirmed message.
  const canPin = canModerate && !isPending && !isFailed;
  const wasEdited = event.tags.some(([name]) => name === "edited");
  const [editText, setEditText] = useState(event.content);
  // Two-step delete: the first click arms (highlights) the trash button, the
  // second click within the timeout actually deletes. Prevents fat-finger
  // deletes from a single misclick.
  const [deleteArmed, setDeleteArmed] = useState(false);
  const disarmTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  // Touch devices have no hover, so the action toolbar (reply/react/thread/…)
  // would never appear. Tapping the message toggles it "active" to keep the
  // toolbar open for interaction; tapping again (or another message) closes it.
  const [active, setActive] = useState(false);

  const disarmDelete = useCallback(() => {
    if (disarmTimer.current) clearTimeout(disarmTimer.current);
    disarmTimer.current = null;
    setDeleteArmed(false);
  }, []);

  const handleDeleteClick = useCallback(() => {
    if (deleteArmed) {
      disarmDelete();
      onDelete(event);
    } else {
      setDeleteArmed(true);
      if (disarmTimer.current) clearTimeout(disarmTimer.current);
      disarmTimer.current = setTimeout(() => setDeleteArmed(false), 3000);
    }
  }, [deleteArmed, disarmDelete, onDelete, event]);

  // Clean up the disarm timer on unmount.
  useEffect(() => () => {
    if (disarmTimer.current) clearTimeout(disarmTimer.current);
  }, []);

  // Reset the draft whenever an edit (re)starts.
  useEffect(() => {
    if (isEditing) setEditText(event.content);
  }, [isEditing, event.content]);

  // Toggle the toolbar on tap, but ignore taps that land on interactive
  // children (buttons, links, inputs, mention chips) so those still act
  // normally instead of being swallowed by the toggle.
  const handleRowClick = useCallback((e: React.MouseEvent) => {
    if ((e.target as HTMLElement).closest("button, a, input, textarea, [role='button']")) return;
    setActive((v) => !v);
  }, []);

  const toolbar = (
    <>
      {canWrite && !isEditing && <ReactionPicker onReact={react} />}
            {canWrite && !isEditing && (
              <Tooltip>
                <TooltipTrigger asChild>
                  <Button
                    variant="ghost"
                    size="icon"
                    aria-label="Reply"
                    className="size-7 text-muted-foreground hover:text-primary"
                    onClick={() => onReply(event)}
                  >
                    <Reply className="size-3.5" />
                  </Button>
                </TooltipTrigger>
                <TooltipContent>Reply</TooltipContent>
              </Tooltip>
            )}
            {canWrite && !isEditing && onOpenThread && (
              <Tooltip>
                <TooltipTrigger asChild>
                  <Button
                    variant="ghost"
                    size="icon"
                    aria-label="Reply in thread"
                    className="size-7 text-muted-foreground hover:text-primary"
                    onClick={() => onOpenThread(event)}
                  >
                    <MessagesSquare className="size-3.5" />
                  </Button>
                </TooltipTrigger>
                <TooltipContent>Reply in thread</TooltipContent>
              </Tooltip>
            )}
            {canEdit && !isEditing && (
              <Tooltip>
                <TooltipTrigger asChild>
                  <Button
                    variant="ghost"
                    size="icon"
                    aria-label="Edit message"
                    className="size-7 text-muted-foreground hover:text-primary"
                    onClick={() => onEdit?.(event)}
                  >
                    <Pencil className="size-3.5" />
                  </Button>
                </TooltipTrigger>
                <TooltipContent>Edit message</TooltipContent>
              </Tooltip>
            )}
            {canPin && !isEditing && onTogglePin && (
              <Tooltip>
                <TooltipTrigger asChild>
                  <Button
                    variant="ghost"
                    size="icon"
                    aria-label={isPinned ? "Unpin message" : "Pin message"}
                    aria-pressed={isPinned}
                    className={cn(
                      "size-7",
                      isPinned
                        ? "text-primary hover:text-primary"
                        : "text-muted-foreground hover:text-primary",
                    )}
                    onClick={() => onTogglePin(event)}
                  >
                    {isPinned ? <PinOff className="size-3.5" /> : <Pin className="size-3.5" />}
                  </Button>
                </TooltipTrigger>
                <TooltipContent>{isPinned ? "Unpin message" : "Pin message"}</TooltipContent>
              </Tooltip>
            )}
            {canDelete && !isEditing && (
              <Tooltip>
                <TooltipTrigger asChild>
                  <Button
                    variant="ghost"
                    size="icon"
                    aria-label={deleteArmed ? "Confirm delete message" : "Delete message"}
                    aria-pressed={deleteArmed}
                    className={cn(
                      "size-7 transition-colors",
                      deleteArmed
                        ? "bg-destructive text-destructive-foreground hover:bg-destructive/90"
                        : "text-muted-foreground hover:text-destructive",
                    )}
                    onClick={handleDeleteClick}
                  >
                    <Trash2 className="size-3.5" />
                  </Button>
                </TooltipTrigger>
                <TooltipContent>{deleteArmed ? "Click again to delete" : "Delete message"}</TooltipContent>
              </Tooltip>
            )}
    </>
  );

  const body = (
    <>
        {isEditing ? (
          <div className="mt-0.5">
            <textarea
              autoFocus
              value={editText}
              onChange={(e) => setEditText(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter" && !e.shiftKey) {
                  e.preventDefault();
                  onEditSubmit?.(event, editText);
                } else if (e.key === "Escape") {
                  e.preventDefault();
                  onEditCancel?.();
                }
              }}
              rows={Math.min(6, Math.max(1, editText.split("\n").length))}
              className="w-full resize-none rounded-md bg-background border border-input px-2 py-1.5 text-[15px] focus:outline-none focus-visible:ring-1 focus-visible:ring-ring"
            />
            <div className="flex items-center gap-2 mt-1 text-[11px] text-muted-foreground">
              <button
                type="button"
                className="font-semibold text-primary hover:underline"
                onClick={() => onEditSubmit?.(event, editText)}
              >
                Save
              </button>
              <button type="button" className="hover:text-foreground" onClick={() => onEditCancel?.()}>
                Cancel
              </button>
              <span className="opacity-70">escape to cancel · enter to save</span>
            </div>
          </div>
        ) : event.kind === KIND_POLL ? (
          <>
            <ChatContent event={event} className="text-[15px]" highlight={highlight} />
            <PollCard event={event} relayUrl={relayUrl} groupId={groupId} canVote={canWrite} />
          </>
        ) : isMeAction(event) ? (
          <div className="text-[15px] italic text-muted-foreground">
            <span className="font-semibold not-italic text-primary">{displayName}</span>{" "}
            <ChatContent
              event={event}
              contentOverride={meActionText(event)}
              className="inline italic"
              highlight={highlight}
              noMentionAtPrefix
            />
          </div>
        ) : (
          <ChatContent event={event} className="text-[15px]" highlight={highlight} />
        )}
    </>
  );

  const afterBody = (
    <>
        {!isEditing && <ReactionBar tallies={tallies} canReact={canWrite} onReact={react} />}
        {!isEditing && replyCount > 0 && onOpenThread && (
          <button
            type="button"
            onClick={() => onOpenThread(event)}
            className="mt-0.5 inline-flex items-center gap-1.5 rounded-full px-2 py-0.5 text-[11px] font-medium text-primary hover:bg-primary/10 transition-colors"
          >
            <MessagesSquare className="size-3.5" />
            {replyCount} {replyCount === 1 ? "reply" : "replies"}
          </button>
        )}
        {isFailed && (
          <div className="flex items-center gap-2 mt-1 text-[11px] text-destructive">
            <AlertCircle className="size-3.5 shrink-0" />
            <span>Failed to send.</span>
            <button type="button" className="font-semibold underline hover:no-underline" onClick={onRetry}>
              Retry
            </button>
            <button type="button" className="text-muted-foreground hover:text-foreground" onClick={onDiscard}>
              Discard
            </button>
          </div>
        )}
    </>
  );

  return (
    <MessageRow
      pubkey={event.pubkey}
      createdAt={event.created_at}
      pending={isPending}
      edited={wasEdited && !isEditing}
      actions={toolbar}
      beforeBody={replyToId && <ReplyContext eventId={replyToId} relayUrl={relayUrl} />}
      afterBody={afterBody}
      className={cn(
        active && "bg-secondary/40",
        isPinned && "bg-amber-500/5",
        mentionsMe && "bg-primary/10 hover:bg-primary/15 border-l-2 border-primary pl-2",
        isPending && "opacity-60",
        isFailed && "bg-destructive/5",
      )}
      containerProps={{
        onMouseLeave: disarmDelete,
        onClick: handleRowClick,
        "data-active": active || undefined,
        "data-event-id": event.id,
      } as React.HTMLAttributes<HTMLDivElement>}
    >
      {body}
    </MessageRow>
  );
}

interface GroupChatProps {
  relayUrl: string;
  groupId: string;
  /** Whether the current user can write to this group. */
  canWrite: boolean;
  /** Whether the current user can moderate (delete messages). */
  canModerate: boolean;
  /**
   * Active search query. When non-empty, the timeline is replaced by matching
   * messages (filtered in-place in the chat area, not a separate view).
   */
  searchQuery?: string;
  /**
   * Populated by GroupChat with a function that scrolls a message into view by
   * id (used by the header's pinned-messages popover). The ref's `.current` is
   * assigned on mount and cleared on unmount.
   */
  scrollToMessageRef?: React.MutableRefObject<((id: string) => void) | null>;
}

/**
 * The message timeline + composer for a NIP-29 group. Messages are kind 9
 * (and kind 1068 polls) with the `h` tag and NIP-29 `previous` timeline
 * references, published only to the group's host relay.
 */
export function GroupChat({ relayUrl, groupId, canWrite, canModerate, searchQuery = "", scrollToMessageRef }: GroupChatProps) {
  const { user } = useCurrentUser();
  const {
    data: messages = [],
    isLoading,
    status: sendStatus,
    insertOptimistic,
    markSent,
    markFailed,
    removeOptimistic,
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
  const [threadRoot, setThreadRoot] = useState<NostrEvent | undefined>(undefined);
  // Focus the thread reply input when the panel opens via /thread (vs. just
  // clicking a "N replies" badge to browse).
  const [threadAutoFocus, setThreadAutoFocus] = useState(false);
  // The root kept mounted through the panel's slide-out close animation. It
  // tracks threadRoot when open and lingers (so content stays put) while
  // closing; cleared a beat after threadRoot becomes undefined.
  const [lastThreadRoot, setLastThreadRoot] = useState<NostrEvent | undefined>(undefined);
  const [editingId, setEditingId] = useState<string | undefined>(undefined);
  const [joinDialogOpen, setJoinDialogOpen] = useState(false);
  const [signupDialogOpen, setSignupDialogOpen] = useState(false);
  const scrollRef = useRef<HTMLDivElement>(null);
  const isAutoScrollRef = useRef(true);

  // Keep the thread panel content mounted through its slide-out animation.
  useEffect(() => {
    if (threadRoot) {
      setLastThreadRoot(threadRoot);
      return;
    }
    const t = setTimeout(() => setLastThreadRoot(undefined), 200);
    return () => clearTimeout(t);
  }, [threadRoot]);

  // Mark the channel read up to the newest message while it's on screen. Only
  // when the document is visible so a backgrounded tab doesn't silently clear
  // unread. Re-runs on focus and as new messages stream in.
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

  // Auto-scroll to bottom when new messages arrive (unless user scrolled up).
  useEffect(() => {
    if (isAutoScrollRef.current && scrollRef.current) {
      scrollRef.current.scrollTop = scrollRef.current.scrollHeight;
    }
  }, [messages]);

  // Opening/closing the thread panel reflows the message column (its width
  // animates over ~200ms), which would otherwise let the bottom-anchored view
  // drift. While the panel animates, keep the scroll pinned to the bottom if
  // the user was already there.
  useEffect(() => {
    if (!isAutoScrollRef.current) return;
    let raf = 0;
    const start = performance.now();
    const pin = (now: number) => {
      const el = scrollRef.current;
      if (el) el.scrollTop = el.scrollHeight;
      if (now - start < 260) raf = requestAnimationFrame(pin);
    };
    raf = requestAnimationFrame(pin);
    return () => cancelAnimationFrame(raf);
  }, [threadRoot]);

  const handleScroll = useCallback(() => {
    const el = scrollRef.current;
    if (!el) return;
    isAutoScrollRef.current = el.scrollHeight - el.scrollTop - el.clientHeight < 60;
  }, []);

  const handleSent = useCallback(() => {
    setReplyTo(undefined);
    isAutoScrollRef.current = true;
  }, []);

  // Open the thread panel for a message. `focusReply` focuses the reply input
  // (used by /thread); badge/button clicks just browse without stealing focus.
  const openThread = useCallback((event: NostrEvent, focusReply = false) => {
    setThreadAutoFocus(focusReply);
    setThreadRoot(event);
  }, []);

  // Run a slash command delegated by the composer (/thread, /kick, /ban). The
  // composer resolves any target pubkey and resets itself.
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

  // Retry a failed optimistic message: re-publish the already-signed event
  // (id preserved) and reconcile status on the result.
  const handleRetry = useCallback(
    async (event: NostrEvent) => {
      markFailed(event.id); // keep it visible; flip back to pending below
      try {
        await republish({ event, relay: relayUrl });
        markSent(event.id);
      } catch {
        markFailed(event.id);
      }
    },
    [republish, relayUrl, markSent, markFailed],
  );

  // Delete a message: the author's own posts go out as NIP-09 kind 5 deletions;
  // moderators deleting others' posts use the NIP-29 moderation event.
  const handleDelete = useCallback(    (event: NostrEvent) => {
      if (user?.pubkey === event.pubkey) {
        deleteOwnMessage({ event });
      } else {
        deleteEvent.mutate({ eventId: event.id });
      }
    },
    [user?.pubkey, deleteOwnMessage, deleteEvent],
  );

  // Pin/unpin a message (admins/moderators). Publishes the updated 39041 set;
  // the relay rejects the write from non-admins.
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

  // Scroll a (pinned) message into view and flash it. No-op if it's not in the
  // currently-loaded timeline.
  const scrollToMessage = useCallback((id: string) => {
    const el = scrollRef.current?.querySelector<HTMLElement>(`[data-event-id="${id}"]`);
    if (!el) {
      toast({ title: "Message not loaded", description: "Scroll up to load older messages." });
      return;
    }
    isAutoScrollRef.current = false;
    el.scrollIntoView({ behavior: "smooth", block: "center" });
    el.classList.add("ring-2", "ring-amber-400", "ring-inset");
    setTimeout(() => el.classList.remove("ring-2", "ring-amber-400", "ring-inset"), 1600);
  }, []);

  // Expose scrollToMessage to the parent (the channel header's pinned-messages
  // popover jumps to a message by calling through this ref).
  useEffect(() => {
    if (!scrollToMessageRef) return;
    scrollToMessageRef.current = scrollToMessage;
    return () => {
      scrollToMessageRef.current = null;
    };
  }, [scrollToMessageRef, scrollToMessage]);

  // Submit an inline edit: delete the original + republish at its timestamp,
  // optimistically swapping the original message for the edited one.
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
        // Swap the original for the edited event (which keeps its timestamp).
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

  return (
    <div className="relative flex flex-1 min-h-0 min-w-0">
      <div className="relative flex flex-col flex-1 min-h-0 min-w-0">
      {/* Messages (or search results, filtered in-place) */}
      <div
        ref={scrollRef}
        onScroll={handleScroll}
        className="flex-1 min-h-0 overflow-y-auto overflow-x-hidden overscroll-contain scrollbar-stable px-3 py-4 space-y-1"
      >
        {searching ? (
          searchLoading ? (
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
                  <ChatMessage
                    key={msg.id}
                    event={msg}
                    relayUrl={relayUrl}
                    groupId={groupId}
                    canWrite={Boolean(user && canWrite)}
                    canModerate={canModerate}
                    highlight={searchQuery}
                    isPinned={isPinned(msg.id)}
                    onTogglePin={handleTogglePin}
                    onDelete={handleDelete}
                    onReply={setReplyTo}
                  />
                ))}
            </>
          )
        ) : isLoading ? (
          <div className="space-y-3 p-2">
            {Array.from({ length: 8 }).map((_, i) => (
              <div key={i} className="flex items-start gap-3">
                <Skeleton className="size-10 rounded-full shrink-0" />
                <div className="space-y-1 flex-1">
                  <Skeleton className="h-3 w-24" />
                  <Skeleton className="h-3 w-2/3" />
                </div>
              </div>
            ))}
          </div>
        ) : messages.length === 0 ? (
          <div className="flex flex-col items-center justify-center py-16 text-center">
            <Hash className="size-10 text-muted-foreground/40 mb-3" />
            <p className="text-sm text-muted-foreground">No messages yet</p>
            <p className="text-xs text-muted-foreground/60 mt-1">Be the first to say something!</p>
          </div>
        ) : (
          messages.map((msg) => (
            <ChatMessage
              key={msg.id}
              event={msg}
              relayUrl={relayUrl}
              groupId={groupId}
              canWrite={Boolean(user && canWrite)}
              canModerate={canModerate}
              sendStatus={sendStatus[msg.id]}
              isEditing={editingId === msg.id}
              isPinned={isPinned(msg.id)}
              onTogglePin={handleTogglePin}
              onRetry={() => handleRetry(msg)}
              onDiscard={() => removeOptimistic(msg.id)}
              onDelete={handleDelete}
              onReply={setReplyTo}
              onOpenThread={openThread}
              onEdit={(e) => setEditingId(e.id)}
              onEditSubmit={handleEditSubmit}
              onEditCancel={() => setEditingId(undefined)}
            />
          ))
        )}
      </div>

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

      {/* Thread panel. On desktop it's an in-flow sibling whose width animates
          open (0 → fixed). On mobile it overlays the chat (absolute) so the
          message list never reflows/animates when the thread opens or closes. */}
      <div
        className={cn(
          "overflow-hidden",
          "absolute inset-0 z-20 sidebar:static sidebar:z-auto",
          "sidebar:shrink-0 sidebar:w-0 sidebar:transition-[width] sidebar:duration-200 sidebar:ease-out",
          threadRoot ? "sidebar:w-[23rem]" : "pointer-events-none sidebar:pointer-events-auto",
        )}
      >
        {/* Mobile backdrop: fades in/out in sync with the panel slide so the
            chat is blocked once the panel is in view (not before). */}
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
