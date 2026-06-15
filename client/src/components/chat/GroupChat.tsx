import { Hash, Reply, Trash2 } from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";

import { ChatComposer } from "@/components/chat/ChatComposer";
import { ChatContent } from "@/components/chat/ChatContent";
import { PollCard } from "@/components/chat/PollCard";
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
import { useReactions } from "@/hooks/useReactions";
import { getAvatarShape } from "@/lib/avatarShape";
import { getDisplayName } from "@/lib/getDisplayName";

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
  onDelete: (eventId: string) => void;
  onReply: (event: NostrEvent) => void;
}

function ChatMessage({ event, relayUrl, groupId, canWrite, canModerate, onDelete, onReply }: ChatMessageProps) {
  const author = useAuthor(event.pubkey);
  const metadata = author.data?.metadata;
  const displayName = getDisplayName(metadata, event.pubkey);
  const replyToId = getReplyToId(event);
  const { tallies, react } = useReactions(event, relayUrl, groupId);

  return (
    <div className="group flex items-start gap-2.5 py-1 px-2 rounded hover:bg-secondary/40 transition-colors">
      <Avatar shape={getAvatarShape(metadata)} className="size-8 shrink-0 mt-0.5">
        <AvatarImage src={metadata?.picture} alt={displayName} />
        <AvatarFallback className="bg-primary/20 text-primary text-xs">
          {displayName[0]?.toUpperCase()}
        </AvatarFallback>
      </Avatar>
      <div className="flex-1 min-w-0">
        <div className="flex items-baseline gap-2">
          <span className="text-sm font-semibold text-primary truncate">{displayName}</span>
          <span className="text-[10px] text-muted-foreground/70 shrink-0">
            {shortTimeAgo(event.created_at)}
          </span>
        </div>
        {replyToId && <ReplyContext eventId={replyToId} relayUrl={relayUrl} />}
        {event.kind === KIND_POLL
          ? (
            <>
              <ChatContent event={event} className="text-sm" />
              <PollCard event={event} relayUrl={relayUrl} groupId={groupId} canVote={canWrite} />
            </>
          )
          : <ChatContent event={event} className="text-sm" />}
        <ReactionBar tallies={tallies} canReact={canWrite} onReact={react} />
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
}

/**
 * The message timeline + composer for a NIP-29 group. Messages are kind 9
 * (and kind 1068 polls) with the `h` tag and NIP-29 `previous` timeline
 * references, published only to the group's host relay.
 */
export function GroupChat({ relayUrl, groupId, canWrite, canModerate }: GroupChatProps) {
  const { user } = useCurrentUser();
  const { data: messages = [], isLoading } = useGroupMessages(relayUrl, groupId);
  const { deleteEvent } = useGroupModeration(relayUrl, groupId);
  const [replyTo, setReplyTo] = useState<NostrEvent | undefined>(undefined);
  const [joinDialogOpen, setJoinDialogOpen] = useState(false);
  const [signupDialogOpen, setSignupDialogOpen] = useState(false);
  const scrollRef = useRef<HTMLDivElement>(null);
  const isAutoScrollRef = useRef(true);

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

  return (
    <div className="flex flex-col flex-1 min-h-0 min-w-0">
      {/* Messages */}
      <div
        ref={scrollRef}
        onScroll={handleScroll}
        className="flex-1 min-h-0 overflow-y-auto overflow-x-hidden overscroll-contain px-2 py-3 space-y-0.5"
      >
        {isLoading ? (
          <div className="space-y-3 p-2">
            {Array.from({ length: 8 }).map((_, i) => (
              <div key={i} className="flex items-start gap-2">
                <Skeleton className="size-8 rounded-full shrink-0" />
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
