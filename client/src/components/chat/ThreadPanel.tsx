import { Loader2, MessagesSquare, X } from "lucide-react";

import { ChatComposer } from "@/components/chat/ChatComposer";
import { ChatContent } from "@/components/chat/ChatContent";
import { ProfilePreviewCard } from "@/components/chat/ProfilePreviewCard";
import { Avatar, AvatarFallback, AvatarImage } from "@/components/ui/avatar";
import { Button } from "@/components/ui/button";
import { useAuthor } from "@/hooks/useAuthor";
import { useScopedDisplayName } from "@/hooks/useScopedDisplayName";
import { useThread } from "@/hooks/useThread";
import { getAvatarShape } from "@/lib/avatarShape";

import type { NostrEvent } from "@nostrify/nostrify";

/** A single message row inside the thread panel (root or reply). */
function ThreadMessage({ event }: { event: NostrEvent }) {
  const author = useAuthor(event.pubkey);
  const metadata = author.data?.metadata;
  const displayName = useScopedDisplayName(event.pubkey, metadata);
  const when = new Date(event.created_at * 1000);

  return (
    <div className="flex items-start gap-3 py-1.5 px-2.5 rounded hover:bg-secondary/40 transition-colors">
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
      </div>
    </div>
  );
}

interface ThreadPanelProps {
  /** The root chat message this thread hangs off. */
  root: NostrEvent;
  relayUrl: string;
  groupId: string;
  /** Whether the current user can post replies. */
  canWrite: boolean;
  /** Focus the reply input on open (e.g. when launched via /thread). */
  autoFocus?: boolean;
  onClose: () => void;
}

/**
 * Side panel showing a message thread: the root message, its NIP-22 kind-1111
 * replies, and a composer for posting a new reply. Sits beside the channel
 * timeline (Slack/Discord style); replies never appear in the main timeline
 * because that view is filtered to kind 9.
 */
export function ThreadPanel({ root, relayUrl, groupId, canWrite, autoFocus = false, onClose }: ThreadPanelProps) {
  const { replies, isLoading, sendReply } = useThread(root, relayUrl, groupId);

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
        <ThreadMessage event={root} />
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
          replies.map((reply) => <ThreadMessage key={reply.id} event={reply} />)
        )}
      </div>

      {canWrite ? (
        <ChatComposer
          relayUrl={relayUrl}
          groupId={groupId}
          messages={[]}
          placeholder="Reply in thread…"
          draftScope={`thread:${root.id}`}
          autoFocus={autoFocus}
          sendOverride={async (text) => {
            await sendReply(text);
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
