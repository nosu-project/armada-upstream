import { Hash, Lock, MessageSquareText, Volume2 } from "lucide-react";

import { cn } from "@/lib/utils";

import type { ChannelView } from "@/concord/lib/types";

/**
 * A channel's glyph: a hashtag for a text channel, the forum's post mark for a
 * forum, a speaker while a call is live. A private TEXT channel is a bare
 * padlock (the long-standing mark); a private FORUM keeps its forum mark and
 * wears a small padlock in the corner, so it still reads as a forum first. The
 * badge sits on a `bg-background` disc so it reads over any row background.
 *
 * One component for every surface that names a channel — the sidebar, the
 * header, the aggregate views, the settings list, the drag ghosts — so a
 * private forum is drawn the same way everywhere rather than as a forum in
 * one place and a padlock in another.
 */
export function ChannelGlyph({
  isPrivate = false,
  view,
  occupied = false,
  className,
}: {
  isPrivate?: boolean;
  view?: ChannelView;
  occupied?: boolean;
  className?: string;
}) {
  if (occupied) return <Volume2 className={className} />;
  if (view === "forum") {
    if (!isPrivate) return <MessageSquareText className={className} />;
    return (
      <span className={cn("relative inline-flex shrink-0", className)}>
        <MessageSquareText className="size-full" />
        <span className="absolute -bottom-1 -right-1 inline-flex size-[62%] items-center justify-center rounded-full bg-background">
          <Lock className="size-[72%]" strokeWidth={2.75} />
        </span>
      </span>
    );
  }
  if (isPrivate) return <Lock className={className} />;
  return <Hash className={className} />;
}
