import { AlertCircle, Hash, Loader2, Pencil, Reply, Search, Trash2 } from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";

import { ChatComposer } from "@/components/chat/ChatComposer";
import { ChatContent } from "@/components/chat/ChatContent";
import { PollCard } from "@/components/chat/PollCard";
import { ProfilePreviewCard } from "@/components/chat/ProfilePreviewCard";
import { ReactionBar, ReactionPicker } from "@/components/chat/ReactionBar";
import LoginDialog from "@/components/auth/LoginDialog";
import SignupDialog from "@/components/auth/SignupDialog";
import { Avatar, AvatarFallback, AvatarImage } from "@/components/ui/avatar";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { useAuthor } from "@/hooks/useAuthor";
import { useCurrentUser } from "@/hooks/useCurrentUser";
import { useEvent } from "@/hooks/useEvent";
import { useGroupMessages } from "@/hooks/useGroupMessages";
import { useGroupModeration } from "@/hooks/useGroupModeration";
import { useGroupSearch } from "@/hooks/useGroupSearch";
import { useEditMessage } from "@/hooks/useEditMessage";
import { useReactions } from "@/hooks/useReactions";
import { useRepublish } from "@/hooks/useNostrPublish";
import { channelReadKey, useReadState } from "@/hooks/useReadState";
import { toast } from "@/hooks/useToast";
import { getAvatarShape } from "@/lib/avatarShape";
import { getDisplayName } from "@/lib/getDisplayName";
import { KIND_GROUP_CHAT } from "@/lib/nip29";
import { cn } from "@/lib/utils";

import type { SendStatus } from "@/hooks/useGroupMessages";

import type { NostrEvent } from "@nostrify/nostrify";

/** NIP-88 poll kind. */
const KIND_POLL = 1068;

/** Format seconds-ago into a short time string. */
function shortTimeAgo(timestamp: number): string {
  const diff = Math.floor(Date.now() / 1000) - timestamp;
  if (diff < 60) return "now";
  if (diff < 3600) return `${Math.floor(diff / 60)}m`;
  if (diff < 86400) return `${Math.floor(diff / 3600)}h`;
  return `${Math.floor(diff / 86400)}d`;
}

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
  onRetry?: () => void;
  onDiscard?: () => void;
  onDelete: (eventId: string) => void;
  onReply: (event: NostrEvent) => void;
  /** Begin editing this message (own, non-poll messages only). */
  onEdit?: (event: NostrEvent) => void;
  /** Submit an inline edit with new content. */
  onEditSubmit?: (event: NostrEvent, content: string) => void;
  /** Cancel an in-progress inline edit. */
  onEditCancel?: () => void;
}

function ChatMessage({ event, relayUrl, groupId, canWrite, canModerate, sendStatus, highlight, isEditing, onRetry, onDiscard, onDelete, onReply, onEdit, onEditSubmit, onEditCancel }: ChatMessageProps) {
  const { user } = useCurrentUser();
  const author = useAuthor(event.pubkey);
  const metadata = author.data?.metadata;
  const displayName = getDisplayName(metadata, event.pubkey);
  const replyToId = getReplyToId(event);
  const { tallies, react } = useReactions(event, relayUrl, groupId);
  const isPending = sendStatus === "pending";
  const isFailed = sendStatus === "failed";
  const isOwn = user?.pubkey === event.pubkey;
  // Only plain chat messages are editable (polls carry structured tags).
  const canEdit = isOwn && event.kind === KIND_GROUP_CHAT && !isPending && !isFailed;
  const wasEdited = event.tags.some(([name]) => name === "edited");
  const [editText, setEditText] = useState(event.content);
  // Two-step delete: the first click arms (highlights) the trash button, the
  // second click within the timeout actually deletes. Prevents fat-finger
  // deletes from a single misclick.
  const [deleteArmed, setDeleteArmed] = useState(false);
  const disarmTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const disarmDelete = useCallback(() => {
    if (disarmTimer.current) clearTimeout(disarmTimer.current);
    disarmTimer.current = null;
    setDeleteArmed(false);
  }, []);

  const handleDeleteClick = useCallback(() => {
    if (deleteArmed) {
      disarmDelete();
      onDelete(event.id);
    } else {
      setDeleteArmed(true);
      if (disarmTimer.current) clearTimeout(disarmTimer.current);
      disarmTimer.current = setTimeout(() => setDeleteArmed(false), 3000);
    }
  }, [deleteArmed, disarmDelete, onDelete, event.id]);

  // Clean up the disarm timer on unmount.
  useEffect(() => () => {
    if (disarmTimer.current) clearTimeout(disarmTimer.current);
  }, []);

  // Reset the draft whenever an edit (re)starts.
  useEffect(() => {
    if (isEditing) setEditText(event.content);
  }, [isEditing, event.content]);

  return (
    <div
      onMouseLeave={disarmDelete}
      className={cn(
        "group flex items-start gap-3 py-1.5 px-2.5 rounded hover:bg-secondary/40 transition-colors",
        isPending && "opacity-60",
        isFailed && "bg-destructive/5",
      )}
    >
      <ProfilePreviewCard pubkey={event.pubkey}>
        <button type="button" className="shrink-0 mt-0.5 rounded-full focus:outline-none focus-visible:ring-2 focus-visible:ring-ring">
          <Avatar shape={getAvatarShape(metadata)} className="size-10 cursor-pointer transition-opacity hover:opacity-90">
            <AvatarImage src={metadata?.picture} alt={displayName} />
            <AvatarFallback className="bg-primary/20 text-primary text-sm">
              {displayName[0]?.toUpperCase()}
            </AvatarFallback>
          </Avatar>
        </button>
      </ProfilePreviewCard>
      <div className="flex-1 min-w-0">
        <div className="flex items-baseline gap-2">
          <ProfilePreviewCard pubkey={event.pubkey}>
            <button type="button" className="text-[15px] font-semibold text-primary truncate hover:underline focus:outline-none">
              {displayName}
            </button>
          </ProfilePreviewCard>
          <span className="text-[11px] text-muted-foreground/70 shrink-0">
            {shortTimeAgo(event.created_at)}
          </span>
          {wasEdited && !isEditing && (
            <span className="text-[10px] text-muted-foreground/60 shrink-0" title="Edited">(edited)</span>
          )}
          {isPending && (
            <Loader2 className="size-3 shrink-0 animate-spin text-muted-foreground/70" aria-label="Sending" />
          )}
        </div>
        {replyToId && <ReplyContext eventId={replyToId} relayUrl={relayUrl} />}
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
        ) : (
          <ChatContent event={event} className="text-[15px]" highlight={highlight} />
        )}
        {!isEditing && <ReactionBar tallies={tallies} canReact={canWrite} onReact={react} />}
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
      </div>
      <div className="flex items-center gap-0.5 opacity-0 group-hover:opacity-100 shrink-0">
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
        {canModerate && !isEditing && (
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
      </div>
    </div>
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
}

/**
 * The message timeline + composer for a NIP-29 group. Messages are kind 9
 * (and kind 1068 polls) with the `h` tag and NIP-29 `previous` timeline
 * references, published only to the group's host relay.
 */
export function GroupChat({ relayUrl, groupId, canWrite, canModerate, searchQuery = "" }: GroupChatProps) {
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
  const { deleteEvent } = useGroupModeration(relayUrl, groupId);
  const { mutateAsync: republish } = useRepublish();
  const { mutateAsync: editMessage } = useEditMessage(relayUrl, groupId);
  const { markRead } = useReadState();
  const { results: searchResults, isLoading: searchLoading, active: searching } = useGroupSearch(
    relayUrl,
    groupId,
    searchQuery,
  );
  const [replyTo, setReplyTo] = useState<NostrEvent | undefined>(undefined);
  const [editingId, setEditingId] = useState<string | undefined>(undefined);
  const [joinDialogOpen, setJoinDialogOpen] = useState(false);
  const [signupDialogOpen, setSignupDialogOpen] = useState(false);
  const scrollRef = useRef<HTMLDivElement>(null);
  const isAutoScrollRef = useRef(true);

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

  const handleScroll = useCallback(() => {
    const el = scrollRef.current;
    if (!el) return;
    isAutoScrollRef.current = el.scrollHeight - el.scrollTop - el.clientHeight < 60;
  }, []);

  const handleSent = useCallback(() => {
    setReplyTo(undefined);
    isAutoScrollRef.current = true;
  }, []);

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
    <div className="relative flex flex-col flex-1 min-h-0 min-w-0">
      {/* Messages (or search results, filtered in-place) */}
      <div
        ref={scrollRef}
        onScroll={handleScroll}
        className="flex-1 min-h-0 overflow-y-auto overflow-x-hidden overscroll-contain px-3 py-4 space-y-1"
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
                    onDelete={(eventId) => deleteEvent.mutate({ eventId })}
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
              onRetry={() => handleRetry(msg)}
              onDiscard={() => removeOptimistic(msg.id)}
              onDelete={(eventId) => deleteEvent.mutate({ eventId })}
              onReply={setReplyTo}
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
                className="rounded-full h-7 px-4"
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
  );
}
