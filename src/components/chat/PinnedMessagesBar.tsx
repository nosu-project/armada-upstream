import { Pin, X } from "lucide-react";

import { DisplayName } from "@/components/DisplayName";
import { Button } from "@/components/ui/button";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { useAuthor } from "@/hooks/useAuthor";
import { useAddrEvent, useEvent } from "@/hooks/useEvent";
import { useScopedDisplayName } from "@/hooks/useScopedDisplayName";
import { parseAddrPinRef, type PinAddr } from "@/lib/nip29";
import { cn } from "@/lib/utils";

/** Strip URLs to a paperclip for a compact one-line-ish preview. */
function previewText(content: string): string {
  return content.replace(/https?:\/\/\S+/g, "📎").trim() || "📎";
}

/** One row in the pinned-messages bar: a clickable preview + optional unpin. */
function PinnedRow({
  eventId,
  relayUrl,
  canModerate,
  onJump,
  onUnpin,
}: {
  eventId: string;
  relayUrl: string;
  canModerate: boolean;
  onJump: (id: string) => void;
  onUnpin: (ref: string) => void;
}) {
  const { data: event } = useEvent(eventId, [relayUrl]);
  const author = useAuthor(event?.pubkey);
  const scopedName = useScopedDisplayName(event?.pubkey, author.data?.metadata);
  const displayName = event ? scopedName : "";
  const preview = event ? previewText(event.content) : "Pinned message";

  return (
    <div className="group/pin flex items-start gap-2 min-w-0 rounded-md px-2 py-1.5 hover:bg-secondary/60">
      <button
        type="button"
        onClick={() => onJump(eventId)}
        className="flex min-w-0 flex-1 flex-col items-start gap-0.5 text-left"
      >
        {event && (
          <span className="text-[11px] font-semibold text-primary truncate max-w-full">
            <DisplayName pubkey={event.pubkey} name={displayName} />
          </span>
        )}
        <span className="text-[12px] text-muted-foreground line-clamp-2 break-words">
          {preview}
        </span>
      </button>
      <Tooltip>
        <TooltipTrigger asChild>
          <Button
            variant="ghost"
            size="sm"
            className="h-6 touch:h-9 shrink-0 px-2 touch:px-3 text-[11px] text-muted-foreground hover:text-primary"
            onClick={() => onJump(eventId)}
          >
            Jump
          </Button>
        </TooltipTrigger>
        <TooltipContent>Jump to message</TooltipContent>
      </Tooltip>
      {canModerate && (
        <Tooltip>
          <TooltipTrigger asChild>
            <Button
              variant="ghost"
              size="icon"
              aria-label="Unpin message"
              className="size-6 touch:size-10 shrink-0 text-muted-foreground hover:text-destructive opacity-0 group-hover/pin:opacity-100 touch:opacity-100 focus-visible:opacity-100 transition-opacity"
              onClick={() => onUnpin(eventId)}
            >
              <X className="size-3.5" />
            </Button>
          </TooltipTrigger>
          <TooltipContent>Unpin</TooltipContent>
        </Tooltip>
      )}
    </div>
  );
}

/** Human-readable label for an addressable pin's kind. */
function addrPinLabel(kind: number): string {
  switch (kind) {
    case 30023:
      return "Article";
    case 30818:
      return "Wiki page";
    case 31922:
    case 31923:
      return "Calendar event";
    default:
      return `Kind ${kind}`;
  }
}

/**
 * One row for an addressable (`a`-tag) pin — e.g. a long-form post or wiki
 * page pinned by another client. Not a timeline message, so there's no jump;
 * it's a labeled preview with an optional unpin.
 */
function PinnedAddrRow({
  pinRef,
  addr,
  relayUrl,
  canModerate,
  onUnpin,
}: {
  pinRef: string;
  addr: PinAddr;
  relayUrl: string;
  canModerate: boolean;
  onUnpin: (ref: string) => void;
}) {
  const { data: event } = useAddrEvent(addr, [relayUrl]);
  const author = useAuthor(event?.pubkey);
  const scopedName = useScopedDisplayName(event?.pubkey, author.data?.metadata);
  const title = event?.tags.find(([n]) => n === "title")?.[1];
  const preview = event ? title || previewText(event.content) : "Pinned event";

  return (
    <div className="group/pin flex items-start gap-2 min-w-0 rounded-md px-2 py-1.5 hover:bg-secondary/60">
      <div className="flex min-w-0 flex-1 flex-col items-start gap-0.5">
        <span className="flex max-w-full items-center gap-1.5">
          <span className="shrink-0 text-[10px] font-semibold uppercase tracking-wide text-amber-500/90">
            {addrPinLabel(addr.kind)}
          </span>
          {event && (
            <span className="text-[11px] font-semibold text-primary truncate">
              <DisplayName pubkey={event.pubkey} name={scopedName} />
            </span>
          )}
        </span>
        <span className="text-[12px] text-muted-foreground line-clamp-2 break-words">
          {preview}
        </span>
      </div>
      {canModerate && (
        <Tooltip>
          <TooltipTrigger asChild>
            <Button
              variant="ghost"
              size="icon"
              aria-label="Unpin event"
              className="size-6 touch:size-10 shrink-0 text-muted-foreground hover:text-destructive opacity-0 group-hover/pin:opacity-100 touch:opacity-100 focus-visible:opacity-100 transition-opacity"
              onClick={() => onUnpin(pinRef)}
            >
              <X className="size-3.5" />
            </Button>
          </TooltipTrigger>
          <TooltipContent>Unpin</TooltipContent>
        </Tooltip>
      )}
    </div>
  );
}

interface PinnedMessagesBarProps {
  open: boolean;
  /** Pin references in display order: event ids and address coordinates. */
  pinnedRefs: string[];
  relayUrl: string;
  canModerate: boolean;
  /** Scroll a message into view in the timeline (provided by GroupChat). */
  onJump: (id: string) => void;
  onUnpin: (ref: string) => void;
  onClose: () => void;
}

/**
 * A bar that slides open below the channel header to browse the group's pinned
 * messages. Each message row links to jump to the message; admins/mods can
 * unpin. Animates its height open/closed; collapses to zero when there's
 * nothing to show.
 */
export function PinnedMessagesBar({
  open,
  pinnedRefs,
  relayUrl,
  canModerate,
  onJump,
  onUnpin,
  onClose,
}: PinnedMessagesBarProps) {
  const expanded = open && pinnedRefs.length > 0;

  return (
    <div
      className={cn(
        "shrink-0 mx-2 overflow-hidden transition-all duration-300 ease-in-out",
        expanded ? "mt-2 max-h-72 opacity-100" : "mt-0 max-h-0 opacity-0",
      )}
      aria-hidden={!expanded}
    >
      <div className="clip-corner-lg bg-chrome px-3 py-2.5">
        <div className="flex items-center justify-between gap-2 mb-1.5">
          <span className="flex items-center gap-1.5 text-[11px] font-semibold uppercase tracking-wide text-muted-foreground/80">
            <Pin className="size-3 text-amber-500" />
            Pinned messages
          </span>
          <Button
            variant="ghost"
            size="icon"
            aria-label="Close pinned messages"
            className="size-6 touch:size-10 text-muted-foreground"
            onClick={onClose}
          >
            <X className="size-3.5" />
          </Button>
        </div>
        <div className="max-h-56 overflow-y-auto space-y-0.5 pr-0.5">
          {pinnedRefs.map((ref) => {
            const addr = parseAddrPinRef(ref);
            return addr ? (
              <PinnedAddrRow
                key={ref}
                pinRef={ref}
                addr={addr}
                relayUrl={relayUrl}
                canModerate={canModerate}
                onUnpin={onUnpin}
              />
            ) : (
              <PinnedRow
                key={ref}
                eventId={ref}
                relayUrl={relayUrl}
                canModerate={canModerate}
                onJump={onJump}
                onUnpin={onUnpin}
              />
            );
          })}
        </div>
      </div>
    </div>
  );
}
