import { FileQuestion } from "lucide-react";
import { nip19 } from "nostr-tools";

import { ChatContent } from "@/components/chat/ChatContent";
import { CustomEmojiImg, EmojifiedText } from "@/components/chat/CustomEmoji";
import { Avatar, AvatarFallback, AvatarImage } from "@/components/ui/avatar";
import { Skeleton } from "@/components/ui/skeleton";
import { useAddrEvent, useEvent, type AddrCoords } from "@/hooks/useEvent";
import { useAuthor } from "@/hooks/useAuthor";
import { getAvatarShape } from "@/lib/avatarShape";
import { getCustomEmojiUrl, isCustomEmoji } from "@/lib/customEmoji";
import { shortTimeAgo } from "@/lib/formatTime";
import { getDisplayName } from "@/lib/getDisplayName";
import { cn } from "@/lib/utils";

import type { NostrEvent } from "@nostrify/nostrify";

interface EmbeddedNoteProps {
  /** Hex event ID to fetch and display. */
  eventId: string;
  /** Optional relay hints from the nevent1 identifier. */
  relays?: string[];
  /** Optional author pubkey hint from the nevent1 identifier. */
  authorHint?: string;
  className?: string;
}

/** Human-readable label for non-text kinds rendered in a quoted card. */
function kindLabel(kind: number): string | null {
  switch (kind) {
    case 0:
      return "Profile";
    case 3:
      return "Follow list";
    case 6:
      return "Repost";
    case 7:
      return "Reaction";
    case 1068:
      return "Poll";
    case 9735:
      return "Zap receipt";
    case 30023:
      return "Article";
    case 31922:
    case 31923:
      return "Calendar event";
    default:
      return null;
  }
}

/** Inline embedded note card – like a link preview but for Nostr events. */
export function EmbeddedNote({ eventId, relays, authorHint, className }: EmbeddedNoteProps) {
  const { data: event, isLoading } = useEvent(eventId, relays, authorHint);

  if (isLoading) {
    return <EmbeddedNoteSkeleton className={className} />;
  }

  if (!event) {
    return <EmbeddedNoteTombstone eventId={eventId} className={className} />;
  }

  return <EmbeddedEventCard event={event} className={className} />;
}

/** Inline embedded card for an addressable event (naddr). */
export function EmbeddedNaddr({ addr, className }: { addr: AddrCoords; className?: string }) {
  const { data: event, isLoading } = useAddrEvent(addr);

  if (isLoading) {
    return <EmbeddedNoteSkeleton className={className} />;
  }

  if (!event) {
    let naddr: string | undefined;
    try {
      naddr = nip19.naddrEncode(addr);
    } catch {
      naddr = undefined;
    }
    return <EmbeddedNoteTombstone eventId={naddr ?? addr.identifier} className={className} />;
  }

  return <EmbeddedEventCard event={event} className={className} />;
}

/** Shared card body for any resolved event. */
export function EmbeddedEventCard({ event, className }: { event: NostrEvent; className?: string }) {
  const author = useAuthor(event.pubkey);
  const metadata = author.data?.metadata;
  const displayName = getDisplayName(metadata, event.pubkey);
  const label = kindLabel(event.kind);

  // Addressable events often have a title tag worth surfacing.
  const title = event.tags.find(([name]) => name === "title")?.[1];

  // Reactions render their emoji rather than raw content.
  const reactionEmoji = event.kind === 7
    ? (event.content === "+" || event.content === "" ? "👍" : event.content === "-" ? "👎" : event.content)
    : null;

  return (
    <div
      className={cn(
        "block max-w-md rounded-xl border border-border bg-secondary/20 px-3 py-2.5 my-1.5 overflow-hidden",
        className,
      )}
      onClick={(e) => e.stopPropagation()}
    >
      <div className="flex items-center gap-2 mb-1">
        <Avatar shape={getAvatarShape(metadata)} className="size-5 shrink-0">
          <AvatarImage src={metadata?.picture} alt={displayName} />
          <AvatarFallback className="bg-primary/20 text-primary text-[9px]">
            {displayName[0]?.toUpperCase()}
          </AvatarFallback>
        </Avatar>
        <span className="text-xs font-semibold truncate">
          {author.data?.event
            ? <EmojifiedText tags={author.data.event.tags}>{displayName}</EmojifiedText>
            : displayName}
        </span>
        {label && (
          <span className="text-[10px] px-1.5 py-px rounded-full bg-secondary text-muted-foreground shrink-0">
            {label}
          </span>
        )}
        <span className="text-[10px] text-muted-foreground/70 shrink-0 ml-auto">
          {shortTimeAgo(event.created_at)}
        </span>
      </div>

      {reactionEmoji !== null ? (
        <div className="text-2xl">
          {isCustomEmoji(reactionEmoji)
            ? (() => {
              const url = getCustomEmojiUrl(reactionEmoji, event.tags);
              return url
                ? <CustomEmojiImg name={reactionEmoji.slice(1, -1)} url={url} className="inline h-7 w-7 object-contain" />
                : null;
            })()
            : reactionEmoji}
        </div>
      ) : (
        <div className="max-h-48 overflow-hidden">
          {title && <p className="text-sm font-semibold leading-snug mb-0.5">{title}</p>}
          <ChatContent event={event} className="text-sm" disableNoteEmbeds />
        </div>
      )}
    </div>
  );
}

function EmbeddedNoteSkeleton({ className }: { className?: string }) {
  return (
    <div className={cn("max-w-md rounded-xl border border-border px-3 py-2.5 my-1.5 space-y-2", className)}>
      <div className="flex items-center gap-2">
        <Skeleton className="size-5 rounded-full" />
        <Skeleton className="h-3 w-24" />
      </div>
      <Skeleton className="h-3 w-3/4" />
    </div>
  );
}

function EmbeddedNoteTombstone({ eventId, className }: { eventId: string; className?: string }) {
  return (
    <div
      className={cn(
        "flex items-center gap-2 max-w-md rounded-xl border border-dashed border-border px-3 py-2.5 my-1.5 text-muted-foreground",
        className,
      )}
    >
      <FileQuestion className="size-4 shrink-0" />
      <span className="text-xs truncate">Couldn't load event {eventId.slice(0, 12)}…</span>
    </div>
  );
}
