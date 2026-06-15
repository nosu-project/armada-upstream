import { AlertCircle, Hash, Loader2, Reply, Trash2 } from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";

import { ChatComposer } from "@/components/chat/ChatComposer";
import { ChatContent } from "@/components/chat/ChatContent";
import { PollCard } from "@/components/chat/PollCard";
import { ProfilePreviewCard } from "@/components/chat/ProfilePreviewCard";
import { ReactionBar, ReactionPicker } from "@/components/chat/ReactionBar";
import { GroupSearchPanel } from "@/components/chat/GroupSearchPanel";
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
import { useReactions } from "@/hooks/useReactions";
import { useRepublish } from "@/hooks/useNostrPublish";
import { channelReadKey, useReadState } from "@/hooks/useReadState";
import { getAvatarShape } from "@/lib/avatarShape";
import { getDisplayName } from "@/lib/getDisplayName";
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
  /** Briefly highlight this message (e.g. jumped-to from search). */
  highlight?: boolean;
  onRetry?: () => void;
  onDiscard?: () => void;
  onDelete: (eventId: string) => void;
  onReply: (event: NostrEvent) => void;
}

function ChatMessage({ event, relayUrl, groupId, canWrite, canModerate, sendStatus, highlight, onRetry, onDiscard, onDelete, onReply }: ChatMessageProps) {
  const author = useAuthor(event.pubkey);
  const metadata = author.data?.metadata;
  const displayName = getDisplayName(metadata, event.pubkey);
  const replyToId = getReplyToId(event);
  const { tallies, react } = useReactions(event, relayUrl, groupId);
  const isPending = sendStatus === "pending";
  const isFailed = sendStatus === "failed";

  return (
    <div
      data-message-id={event.id}
      className={cn(
        "group flex items-start gap-3 py-1.5 px-2.5 rounded hover:bg-secondary/40 transition-colors",
        isPending && "opacity-60",
        isFailed && "bg-destructive/5",
        highlight && "bg-primary/10 ring-1 ring-primary/40",
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
          {isPending && (
            <Loader2 className="size-3 shrink-0 animate-spin text-muted-foreground/70" aria-label="Sending" />
          )}
        </div>
        {replyToId && <ReplyContext eventId={replyToId} relayUrl={relayUrl} />}
        {event.kind === KIND_POLL
          ? (
            <>
              <ChatContent event={event} className="text-[15px]" />
              <PollCard event={event} relayUrl={relayUrl} groupId={groupId} canVote={canWrite} />
            </>
          )
          : <ChatContent event={event} className="text-[15px]" />}
        <ReactionBar tallies={tallies} canReact={canWrite} onReact={react} />
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
        {canWrite && <ReactionPicker onReact={react} />}
        {canWrite && (
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
        {canModerate && (
          <Tooltip>
            <TooltipTrigger asChild>
              <Button
                variant="ghost"
                size="icon"
                aria-label="Delete message"
                className="size-7 text-muted-foreground hover:text-destructive"
                onClick={() => onDelete(event.id)}
              >
                <Trash2 className="size-3.5" />
              </Button>
            </TooltipTrigger>
            <TooltipContent>Delete message</TooltipContent>
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
  /** Whether the in-channel search panel is open. */
  searchOpen?: boolean;
  /** Close the search panel. */
  onCloseSearch?: () => void;
}

/**
 * The message timeline + composer for a NIP-29 group. Messages are kind 9
 * (and kind 1068 polls) with the `h` tag and NIP-29 `previous` timeline
 * references, published only to the group's host relay.
 */
export function GroupChat({ relayUrl, groupId, canWrite, canModerate, searchOpen, onCloseSearch }: GroupChatProps) {
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
  const { markRead } = useReadState();
  const [replyTo, setReplyTo] = useState<NostrEvent | undefined>(undefined);
  const [joinDialogOpen, setJoinDialogOpen] = useState(false);
  const [signupDialogOpen, setSignupDialogOpen] = useState(false);
  const [highlightId, setHighlightId] = useState<string | undefined>(undefined);
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

  // Scroll a message into view (e.g. picked from search) and briefly highlight
  // it. Disables auto-scroll-to-bottom so we don't immediately jump away.
  const scrollToMessage = useCallback((event: NostrEvent) => {
    isAutoScrollRef.current = false;
    setHighlightId(event.id);
    requestAnimationFrame(() => {
      const el = scrollRef.current?.querySelector(`[data-message-id="${event.id}"]`);
      el?.scrollIntoView({ block: "center", behavior: "smooth" });
    });
    setTimeout(() => setHighlightId((cur) => (cur === event.id ? undefined : cur)), 2000);
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

  return (
    <div className="relative flex flex-col flex-1 min-h-0 min-w-0">
      {searchOpen && (
        <GroupSearchPanel
          relayUrl={relayUrl}
          groupId={groupId}
          onClose={() => onCloseSearch?.()}
          onPick={scrollToMessage}
        />
      )}
      {/* Messages */}
      <div
        ref={scrollRef}
        onScroll={handleScroll}
        className="flex-1 min-h-0 overflow-y-auto overflow-x-hidden overscroll-contain px-3 py-4 space-y-1"
      >
        {isLoading ? (
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
              highlight={highlightId === msg.id}
              onRetry={() => handleRetry(msg)}
              onDiscard={() => removeOptimistic(msg.id)}
              onDelete={(eventId) => deleteEvent.mutate({ eventId })}
              onReply={setReplyTo}
            />
          ))
        )}
      </div>

      {/* Composer */}
      {user && canWrite ? (
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
