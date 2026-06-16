import { Loader2 } from "lucide-react";

import { ProfilePreviewCard } from "@/components/chat/ProfilePreviewCard";
import { Avatar, AvatarFallback, AvatarImage } from "@/components/ui/avatar";
import { Badge } from "@/components/ui/badge";
import { useAuthor } from "@/hooks/useAuthor";
import { useScopedIdentity } from "@/hooks/useScopedDisplayName";
import { getAvatarShape } from "@/lib/avatarShape";
import { shortClockTime, shortTimeAgo } from "@/lib/formatTime";
import { cn } from "@/lib/utils";

import type { ReactNode } from "react";

interface MessageRowProps {
  /** Author of the message; drives the avatar, display name and profile card. */
  pubkey: string;
  /** Unix-seconds creation time, rendered as a short relative timestamp. */
  createdAt: number;
  /** The message body (rich content, poll, /me action, edit field, …). */
  children: ReactNode;
  /** Whether to show the spinning "sending" indicator next to the name. */
  pending?: boolean;
  /** Whether to show an "(edited)" marker next to the timestamp. */
  edited?: boolean;
  /** Extra controls rendered right-aligned on the header row (action toolbar). */
  actions?: ReactNode;
  /** Extra content rendered above the body (e.g. a reply-context line). */
  beforeBody?: ReactNode;
  /** Extra content rendered below the body (reactions, reply count, errors). */
  afterBody?: ReactNode;
  /**
   * Render as a continuation of the previous message from the same author:
   * hides the avatar/name/timestamp header and tightens spacing, showing only
   * a hover-revealed clock time in the avatar gutter.
   */
  continuation?: boolean;
  className?: string;
  /** Forwarded to the row container (data attrs, handlers). */
  containerProps?: React.HTMLAttributes<HTMLDivElement>;
}

/**
 * Shared presentational shell for a single chat message: a flat, Discord-style
 * row with a per-message avatar, the author's name, a relative timestamp and a
 * body slot. Used by both group chat (`ChatMessage`) and direct messages so the
 * two render identically.
 */
export function MessageRow({
  pubkey,
  createdAt,
  children,
  pending,
  edited,
  actions,
  beforeBody,
  afterBody,
  continuation,
  className,
  containerProps,
}: MessageRowProps) {
  const author = useAuthor(pubkey);
  const metadata = author.data?.metadata;
  const { displayName, color, label } = useScopedIdentity(pubkey, metadata);

  return (
    <div
      {...containerProps}
      className={cn(
        "group relative flex items-start gap-3 px-2.5 rounded hover:bg-secondary/40 transition-colors",
        continuation ? "py-0.5" : "py-1.5",
        className,
        containerProps?.className,
      )}
    >
      {continuation ? (
        <span className="shrink-0 w-10 self-stretch flex items-start justify-end pr-0.5 pt-0.5 text-[10px] leading-none text-muted-foreground/60 opacity-0 group-hover:opacity-100 transition-opacity tabular-nums select-none">
          {shortClockTime(createdAt)}
        </span>
      ) : (
        <ProfilePreviewCard pubkey={pubkey}>
          <button type="button" className="shrink-0 mt-0.5 rounded-full focus:outline-none focus-visible:ring-2 focus-visible:ring-ring">
            <Avatar shape={getAvatarShape(metadata)} className="size-10 cursor-pointer transition-opacity hover:opacity-90">
              <AvatarImage src={metadata?.picture} alt={displayName} />
              <AvatarFallback className="bg-primary/20 text-primary text-sm">
                {displayName[0]?.toUpperCase()}
              </AvatarFallback>
            </Avatar>
          </button>
        </ProfilePreviewCard>
      )}
      <div className="flex-1 min-w-0">
        {!continuation && (
          <div className="flex items-baseline gap-2">
            <ProfilePreviewCard pubkey={pubkey}>
              <button
                type="button"
                className="text-[15px] font-semibold text-primary truncate hover:underline focus:outline-none"
                style={color ? { color } : undefined}
              >
                {displayName}
              </button>
            </ProfilePreviewCard>
            {label && (
              <Badge variant="secondary" className="text-[10px] font-medium shrink-0">
                {label}
              </Badge>
            )}
            <span className="text-[11px] text-muted-foreground/70 shrink-0">
              {shortTimeAgo(createdAt)}
            </span>
            {edited && (
              <span className="text-[10px] text-muted-foreground/60 shrink-0" title="Edited">(edited)</span>
            )}
            {pending && (
              <Loader2 className="size-3 shrink-0 animate-spin text-muted-foreground/70" aria-label="Sending" />
            )}
            {actions && (
              // Negative vertical margins keep the taller icon buttons from
              // increasing the header row's height.
              <div className="ml-auto -my-1.5 flex items-center gap-0.5 self-center opacity-0 group-hover:opacity-100 group-data-[active]:opacity-100 focus-within:opacity-100 transition-opacity">
                {actions}
              </div>
            )}
          </div>
        )}
        {continuation && (edited || pending || actions) && (
          <div className="flex items-center gap-2 absolute right-2.5 top-0 z-10">
            {edited && (
              <span className="text-[10px] text-muted-foreground/60 shrink-0" title="Edited">(edited)</span>
            )}
            {pending && (
              <Loader2 className="size-3 shrink-0 animate-spin text-muted-foreground/70" aria-label="Sending" />
            )}
            {actions && (
              <div className="flex items-center gap-0.5 opacity-0 group-hover:opacity-100 group-data-[active]:opacity-100 focus-within:opacity-100 transition-opacity">
                {actions}
              </div>
            )}
          </div>
        )}
        {beforeBody}
        {children}
        {afterBody}
      </div>
    </div>
  );
}
