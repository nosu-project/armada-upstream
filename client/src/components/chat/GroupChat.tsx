import { Hash, Send, Trash2 } from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";

import { ChatContent } from "@/components/chat/ChatContent";
import { Avatar, AvatarFallback, AvatarImage } from "@/components/ui/avatar";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Skeleton } from "@/components/ui/skeleton";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { useAuthor } from "@/hooks/useAuthor";
import { useCurrentUser } from "@/hooks/useCurrentUser";
import { useGroupMessages } from "@/hooks/useGroupMessages";
import { useGroupModeration } from "@/hooks/useGroupModeration";
import { useNostrPublish } from "@/hooks/useNostrPublish";
import { getAvatarShape } from "@/lib/avatarShape";
import { getDisplayName } from "@/lib/getDisplayName";
import { buildPreviousRefs, KIND_GROUP_CHAT } from "@/lib/nip29";

import type { NostrEvent } from "@nostrify/nostrify";

/** Format seconds-ago into a short time string. */
function shortTimeAgo(timestamp: number): string {
  const diff = Math.floor(Date.now() / 1000) - timestamp;
  if (diff < 60) return "now";
  if (diff < 3600) return `${Math.floor(diff / 60)}m`;
  if (diff < 86400) return `${Math.floor(diff / 3600)}h`;
  return `${Math.floor(diff / 86400)}d`;
}

interface ChatMessageProps {
  event: NostrEvent;
  canModerate: boolean;
  onDelete: (eventId: string) => void;
}

function ChatMessage({ event, canModerate, onDelete }: ChatMessageProps) {
  const author = useAuthor(event.pubkey);
  const metadata = author.data?.metadata;
  const displayName = getDisplayName(metadata, event.pubkey);

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
        <ChatContent event={event} className="text-sm" />
      </div>
      {canModerate && (
        <Tooltip>
          <TooltipTrigger asChild>
            <Button
              variant="ghost"
              size="icon"
              aria-label="Delete message"
              className="size-7 opacity-0 group-hover:opacity-100 text-muted-foreground hover:text-destructive"
              onClick={() => onDelete(event.id)}
            >
              <Trash2 className="size-3.5" />
            </Button>
          </TooltipTrigger>
          <TooltipContent>Delete message</TooltipContent>
        </Tooltip>
      )}
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
 * with the `h` tag and NIP-29 `previous` timeline references, published only
 * to the group's host relay.
 */
export function GroupChat({ relayUrl, groupId, canWrite, canModerate }: GroupChatProps) {
  const { user } = useCurrentUser();
  const { data: messages = [], isLoading } = useGroupMessages(relayUrl, groupId);
  const { mutateAsync: createEvent, isPending: isSending } = useNostrPublish();
  const { deleteEvent } = useGroupModeration(relayUrl, groupId);
  const [message, setMessage] = useState("");
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

  const handleSend = async () => {
    const text = message.trim();
    if (!text || !user || isSending) return;

    try {
      await createEvent({
        kind: KIND_GROUP_CHAT,
        content: text,
        tags: [
          ["h", groupId],
          ...buildPreviousRefs(messages, user.pubkey).map((ref) => ["previous", ref]),
        ],
        relay: relayUrl,
      });
      setMessage("");
    } catch {
      // Error surfaced by the mutation's onError logging; relay may have
      // rejected the write (not a member, restricted group, etc).
    }
  };

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      handleSend();
    }
  };

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
              canModerate={canModerate}
              onDelete={(eventId) => deleteEvent.mutate({ eventId })}
            />
          ))
        )}
      </div>

      {/* Composer */}
      <div className="border-t p-3 shrink-0">
        {user && canWrite ? (
          <div className="flex gap-2">
            <Input
              value={message}
              onChange={(e) => setMessage(e.target.value)}
              onKeyDown={handleKeyDown}
              placeholder="Message the channel…"
              className="flex-1 h-10 text-base md:text-sm"
              disabled={isSending}
              maxLength={2000}
            />
            <Button
              onClick={handleSend}
              disabled={!message.trim() || isSending}
              aria-label="Send message"
              className="h-10 px-3"
            >
              <Send className="size-4" />
            </Button>
          </div>
        ) : (
          <p className="text-xs text-muted-foreground text-center py-1">
            {user ? "Join this channel to send messages." : "Log in to participate in the chat."}
          </p>
        )}
      </div>
    </div>
  );
}
