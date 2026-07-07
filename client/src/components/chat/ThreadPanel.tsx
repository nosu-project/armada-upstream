import { Loader2, MessagesSquare, X } from "lucide-react";

import { ChatComposer } from "@/components/chat/ChatComposer";
import { ChatContent } from "@/components/chat/ChatContent";
import { ProfilePreviewCard } from "@/components/chat/ProfilePreviewCard";
import { ReactionBar, ReactionPicker } from "@/components/chat/ReactionBar";
import { Avatar, AvatarFallback, AvatarImage } from "@/components/ui/avatar";
import { Button } from "@/components/ui/button";
import { useAuthor } from "@/hooks/useAuthor";
import { useScopedDisplayName } from "@/hooks/useScopedDisplayName";
import { getAvatarShape } from "@/lib/avatarShape";

import type { ChatMsg, ChatTransport, MessageReactions } from "@/components/chat/transport";

/** A single message row inside the thread panel (root or reply). */
function ThreadMessage({
  event,
  reactions,
  canReact,
}: {
  event: ChatMsg;
  reactions?: MessageReactions;
  canReact: boolean;
}) {
  const author = useAuthor(event.pubkey);
  const metadata = author.data?.metadata;
  const displayName = useScopedDisplayName(event.pubkey, metadata);
  const when = new Date(event.created_at * 1000);

  return (
    <div className="group/threadmsg relative flex items-start gap-3 py-1.5 px-2.5 rounded hover:bg-secondary/40 transition-colors">
      <ProfilePreviewCard pubkey={event.pubkey}>
        <button type="button" className="shrink-0 mt-0.5 rounded-full focus:outline-none focus-visible:ring-2 focus-visible:ring-ring">
          <Avatar shape={getAvatarShape(metadata)} className="size-9 cursor-pointer transition-opacity hover:opacity-90">
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
          <span className="text-[11px] text-muted-foreground/70 shrink-0" title={when.toLocaleString()}>
            {when.toLocaleTimeString([], { hour: "numeric", minute: "2-digit" })}
          </span>
        </div>
        <ChatContent event={event} className="text-[15px]" />
        {reactions && reactions.tallies.length > 0 && (
          <ReactionBar tallies={reactions.tallies} canReact={canReact} onReact={reactions.react} />
        )}
      </div>
      {canReact && reactions && (
        <div className="absolute right-1.5 top-1 opacity-0 group-hover/threadmsg:opacity-100 focus-within:opacity-100 transition-opacity">
          <ReactionPicker onReact={reactions.react} />
        </div>
      )}
    </div>
  );
}

interface ThreadPanelProps {
  /** The root chat message this thread hangs off. */
  root: ChatMsg;
  /** The room's transport — supplies the replies, reply-send, and reactions. */
  transport: ChatTransport;
  /**
   * NIP-29 composer context: the group's host relay + `h`-tag id. Concord
   * transports send replies via {@link ChatTransport.sendThreadReply} and don't
   * use these (they pass placeholder values).
   */
  relayUrl: string;
  groupId: string;
  /** Whether the current user can post replies. */
  canWrite: boolean;
  /**
   * Explicit @-mention roster for the reply composer. Required for Concord
   * transports (`relayUrl="dm"` has no NIP-29 group to derive members from);
   * NIP-29 callers can omit it and the composer derives the roster itself.
   */
  mentionPubkeys?: string[];
  /** Focus the reply input on open (e.g. when launched via /thread). */
  autoFocus?: boolean;
  onClose: () => void;
}

/**
 * Side panel showing a message thread: the root message, its replies, and a
 * composer for posting a new reply. Sits beside the channel timeline
 * (Slack/Discord style). It is transport-driven — NIP-29, Concord V1, and
 * Concord V2 all render through it, each supplying its own replies + reply-send
 * via the {@link ChatTransport} (`threadRepliesFor`/`sendThreadReply`), so
 * replies never appear in the main timeline (they're nested here instead).
 */
export function ThreadPanel({ root, transport, relayUrl, groupId, canWrite, mentionPubkeys, autoFocus = false, onClose }: ThreadPanelProps) {
  const replies = transport.threadRepliesFor?.(root.id) ?? [];
  const isLoading = transport.threadLoading?.(root.id) ?? false;
  const reactionsFor = transport.reactionsFor;

  return (
    <aside className="flex flex-col min-h-0 flex-1 min-w-0 m-2 sidebar:my-3 sidebar:mr-2 sidebar:ml-0 p-1.5 clip-corner-lg bg-chrome">
      <div className="flex items-center justify-between px-2 py-1 shrink-0">
        <div className="flex items-center gap-2 min-w-0">
          <MessagesSquare className="size-4 text-muted-foreground shrink-0" />
          <h3 className="text-xs font-semibold uppercase tracking-wider text-muted-foreground truncate">
            Thread{replies.length > 0 ? ` · ${replies.length}` : ""}
          </h3>
        </div>
        <Button variant="ghost" size="icon" aria-label="Close thread" className="size-6" onClick={onClose}>
          <X className="size-4" />
        </Button>
      </div>

      <div className="flex-1 min-h-0 overflow-y-auto overflow-x-hidden overscroll-contain scrollbar-stable space-y-1">
        <ThreadMessage event={root} reactions={reactionsFor?.(root.id)} canReact={canWrite} />
        <div className="flex items-center gap-2 px-3 py-1">
          <div className="h-px flex-1 bg-border/60" />
          {!isLoading && (
            <span className="text-[11px] text-muted-foreground/60 shrink-0">
              {replies.length === 0
                ? "No replies yet"
                : `${replies.length} ${replies.length === 1 ? "reply" : "replies"}`}
            </span>
          )}
          <div className="h-px flex-1 bg-border/60" />
        </div>
        {isLoading ? (
          <div className="flex justify-center py-6">
            <Loader2 className="size-5 animate-spin text-muted-foreground" />
          </div>
        ) : (
          replies.map((reply) => (
            <ThreadMessage key={reply.id} event={reply} reactions={reactionsFor?.(reply.id)} canReact={canWrite} />
          ))
        )}
      </div>

      {canWrite ? (
        <ChatComposer
          relayUrl={relayUrl}
          groupId={groupId}
          messages={[]}
          mentionPubkeys={mentionPubkeys}
          placeholder="Reply in thread…"
          draftScope={`thread:${root.id}`}
          autoFocus={autoFocus}
          sendOverride={async (text, tags) => {
            await transport.sendThreadReply?.(root, text, tags);
          }}
        />
      ) : (
        <div className="p-3 shrink-0 pb-safe">
          <p className="text-xs text-muted-foreground text-center py-1">
            Join this channel to reply.
          </p>
        </div>
      )}
    </aside>
  );
}
