import { ExternalLink, FileQuestion } from "lucide-react";
import { nip19 } from "nostr-tools";

import { DittoIcon } from "@/components/brand/DittoIcon";
import { ChatContent } from "@/components/chat/ChatContent";
import { CustomEmojiImg, EmojifiedText } from "@/components/chat/CustomEmoji";
import { EmojiPackCard } from "@/components/chat/EmojiPackCard";
import { ProfilePreviewCard } from "@/components/chat/ProfilePreviewCard";
import { Avatar, AvatarFallback, AvatarImage } from "@/components/ui/avatar";
import { Skeleton } from "@/components/ui/skeleton";
import { useAddrEvent, useEvent, type AddrCoords } from "@/hooks/useEvent";
import { useAuthor } from "@/hooks/useAuthor";
import { getAvatarShape } from "@/lib/avatarShape";
import { getCustomEmojiUrl, isCustomEmoji } from "@/lib/customEmoji";
import { dittoEventUrl } from "@/lib/dittoUrl";
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

/**
 * Shared card body for any resolved event.
 *
 * Modeled on Ditto's NoteCard/EmbeddedCardShell: a soft `rounded-2xl`
 * card with a whole-card hover tint, an author row (avatar + name +
 * `· timeAgo`), the height-capped note content, and a "View on Ditto"
 * off-ramp footer.
 */
export function EmbeddedEventCard({ event, className }: { event: NostrEvent; className?: string }) {
  // NIP-30 emoji packs get a dedicated preview + "Add" card rather than the
  // generic event body (whose content is empty — the emojis live in tags).
  if (event.kind === 30030) {
    return <EmojiPackCard event={event} className={className} />;
  }
  return <GenericEventCard event={event} className={className} />;
}

function GenericEventCard({ event, className }: { event: NostrEvent; className?: string }) {
  const author = useAuthor(event.pubkey);
  const metadata = author.data?.metadata;
  const displayName = getDisplayName(metadata, event.pubkey);
  const label = kindLabel(event.kind);  // Addressable events often have a title tag worth surfacing.
  const title = event.tags.find(([name]) => name === "title")?.[1];

  // Reactions render their emoji rather than raw content.
  const reactionEmoji = event.kind === 7
    ? (event.content === "+" || event.content === "" ? "👍" : event.content === "-" ? "👎" : event.content)
    : null;

  // Off-ramp to the fuller social view of this event on ditto.pub.
  const dittoHref = dittoEventUrl(event);

  return (
    <div
      className={cn(
        "group block max-w-md w-full rounded-2xl border border-border overflow-hidden",
        "transition-colors hover:bg-secondary/40 my-1.5",
        className,
      )}
      onClick={(e) => e.stopPropagation()}
    >
      <div className="px-3 py-2 space-y-1 min-w-0">
        {/* Author row */}
        <div className="flex items-center gap-2 min-w-0">
          <ProfilePreviewCard pubkey={event.pubkey}>
            <button type="button" className="shrink-0" onClick={(e) => e.stopPropagation()}>
              <Avatar shape={getAvatarShape(metadata)} className="size-5">
                <AvatarImage src={metadata?.picture} alt={displayName} />
                <AvatarFallback className="bg-primary/20 text-primary text-[10px]">
                  {displayName[0]?.toUpperCase()}
                </AvatarFallback>
              </Avatar>
            </button>
          </ProfilePreviewCard>

          <ProfilePreviewCard pubkey={event.pubkey}>
            <button
              type="button"
              className="text-sm font-semibold truncate hover:underline"
              onClick={(e) => e.stopPropagation()}
            >
              {author.data?.event
                ? <EmojifiedText tags={author.data.event.tags}>{displayName}</EmojifiedText>
                : displayName}
            </button>
          </ProfilePreviewCard>

          {label && (
            <span className="text-[10px] px-1.5 py-px rounded-full bg-secondary text-muted-foreground shrink-0">
              {label}
            </span>
          )}

          <span className="text-xs text-muted-foreground shrink-0">
            · {shortTimeAgo(event.created_at)}
          </span>
        </div>

        {/* Body */}
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
          <div className="min-w-0 max-h-64 overflow-hidden">
            {title && <p className="text-sm font-semibold leading-snug mb-0.5 line-clamp-2">{title}</p>}
            <ChatContent event={event} className="text-sm leading-relaxed" clampLines={6} disableNoteEmbeds />
          </div>
        )}

        {/* View on Ditto off-ramp */}
        {dittoHref && <DittoLink href={dittoHref} />}
      </div>
    </div>
  );
}

/**
 * "View on Ditto" off-ramp — a small primary-tinted link appended to an
 * embedded event card so readers can jump to the full social thread on
 * ditto.pub (images, quotes, zaps, replies) that Armada doesn't render.
 */
function DittoLink({ href, label = "View on Ditto" }: { href: string; label?: string }) {
  return (
    <a
      href={href}
      target="_blank"
      rel="noopener noreferrer"
      onClick={(e) => e.stopPropagation()}
      className="mt-0.5 inline-flex items-center gap-1.5 text-xs text-muted-foreground hover:text-primary transition-colors"
    >
      <DittoIcon className="size-3.5 shrink-0" />
      <span>{label}</span>
      <ExternalLink className="size-3 shrink-0" />
    </a>
  );
}

function EmbeddedNoteSkeleton({ className }: { className?: string }) {
  return (
    <div className={cn("max-w-md rounded-2xl border border-border overflow-hidden my-1.5", className)}>
      <div className="px-3 py-2.5 space-y-2">
        <div className="flex items-center gap-2">
          <Skeleton className="size-5 rounded-full shrink-0" />
          <Skeleton className="h-3.5 w-24" />
          <Skeleton className="h-3 w-10" />
        </div>
        <div className="space-y-1.5">
          <Skeleton className="h-3.5 w-full" />
          <Skeleton className="h-3.5 w-4/5" />
        </div>
      </div>
    </div>
  );
}

function EmbeddedNoteTombstone({ eventId, className }: { eventId: string; className?: string }) {
  return (
    <div
      className={cn(
        "flex items-center gap-2 max-w-md rounded-2xl border border-dashed border-border px-3.5 py-4 my-1.5 text-muted-foreground",
        className,
      )}
    >
      <FileQuestion className="size-4 shrink-0" />
      <span className="text-sm truncate">Couldn't load event {eventId.slice(0, 12)}…</span>
    </div>
  );
}
